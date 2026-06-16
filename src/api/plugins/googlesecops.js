import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import NodeCache from 'node-cache';
import { retryOperation } from '../../utils/retryUtils.js';

export default class GoogleSecOpsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'googlesecops';
    this.version = '1.0.0';
    this.description = 'Google SecOps Detection Engine integration with caching and retries';
    this.commands = [
      {
        command: 'listRules',
        description: 'List detection rules (cached)',
        usage: 'listRules [forceRefresh=false] [pageSize] [pageToken]'
      },
      {
        command: 'getRule',
        description: 'Get a detection rule by ID (cached)',
        usage: 'getRule [ruleId]'
      },
      {
        command: 'searchDetections',
        description: 'Search detections within a time window, optionally filter by ruleId or query',
        usage: 'searchDetections [startTime ISO8601] [endTime ISO8601] (optional: ruleId, query, state, pageSize, pageToken)'
      }
    ];
    this.config = null;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
    // Explicit allow-list for getPluginConfig — only baseUrl is safe to expose.
    // accessToken / additionalHeaders carry credentials.
    this.safeConfigKeys = ['baseUrl'];
  }

  async initialize() {
    this.config = this.agent?.serviceConfigs?.googlesecops || {};
    if (!this.config?.baseUrl || !this.config?.accessToken) {
      this.logger.warn('Google SecOps: Missing baseUrl or accessToken in agent.serviceConfigs.googlesecops');
    }
  }

  async execute(params = {}) {
    const { action, ...rest } = params;

    switch ((action || '').trim()) {
      case 'listRules':
        return await this.listRules(rest);

      case 'getRule':
        return await this.getRule(rest);

      case 'searchDetections':
        return await this.searchDetections(rest);

      case 'getPluginConfig':
        return this.getPluginConfig();

      default:
        return {
          success: false,
          error: 'Unknown action. Available actions: listRules, getRule, searchDetections, getPluginConfig'
        };
    }
  }

  // Helpers
  requireConfig() {
    if (!this.config?.baseUrl || !this.config?.accessToken) {
      const err = new Error('Missing configuration: set agent.serviceConfigs.googlesecops = { baseUrl, accessToken }');
      err.code = 'MISSING_CONFIG';
      throw err;
    }
  }

  buildUrl(pathname) {
    const base = (this.config.baseUrl || '').replace(/\/+$/, '');
    const path = String(pathname || '').replace(/^\/+/, '');
    return `${base}/${path}`;
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      'Content-Type': 'application/json',
      ...(this.config.additionalHeaders || {})
    };
  }

  // Commands
  async listRules({ forceRefresh = false, pageSize, pageToken } = {}) {
    try {
      this.requireConfig();

      const cacheKey = `googlesecops:rules:list:${pageSize || ''}:${pageToken || ''}`;
      if (!forceRefresh) {
        const cached = this.cache.get(cacheKey);
        if (cached) {
          this.logger.debug('Google SecOps: listRules served from cache');
          return { success: true, data: cached, cached: true };
        }
      }

      const url = this.buildUrl('v1alpha/detectionengine/rules');
      const params = {};
      if (pageSize) params.pageSize = pageSize;
      if (pageToken) params.pageToken = pageToken;

      const request = async () => {
        return axios.get(url, {
          headers: this.authHeaders(),
          params
        });
      };

      const response = await retryOperation(request, {
        retries: 3,
        minTimeout: 500,
        factor: 2
      });

      const data = response?.data || {};
      this.cache.set(cacheKey, data, 300);
      return { success: true, data };
    } catch (error) {
      this.logger.error(`Google SecOps: listRules failed - ${error.message}`);
      return this.formatHttpError(error);
    }
  }

  async getRule({ ruleId }) {
    if (!ruleId) {
      return { success: false, error: 'Missing required parameter: ruleId' };
    }

    try {
      this.requireConfig();

      const cacheKey = `googlesecops:rules:get:${ruleId}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.logger.debug('Google SecOps: getRule served from cache');
        return { success: true, data: cached, cached: true };
      }

      const url = this.buildUrl(`v1alpha/detectionengine/rules/${encodeURIComponent(ruleId)}`);

      const request = async () => {
        return axios.get(url, { headers: this.authHeaders() });
      };

      const response = await retryOperation(request, {
        retries: 3,
        minTimeout: 500,
        factor: 2
      });

      const data = response?.data || {};
      this.cache.set(cacheKey, data, 300);
      return { success: true, data };
    } catch (error) {
      this.logger.error(`Google SecOps: getRule failed - ${error.message}`);
      return this.formatHttpError(error);
    }
  }

  async searchDetections({ startTime, endTime, ruleId, query, state, pageSize, pageToken } = {}) {
    if (!startTime || !endTime) {
      return { success: false, error: 'Missing required parameters: startTime and endTime (ISO8601)' };
    }

    try {
      this.requireConfig();

      const url = this.buildUrl('v1alpha/detectionengine/detections:search');

      const body = {
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString()
      };

      if (ruleId) body.rule_id = ruleId;
      if (query) body.query = query;
      if (state) body.state = state;
      if (pageSize) body.page_size = pageSize;
      if (pageToken) body.page_token = pageToken;

      const request = async () => {
        return axios.post(url, body, { headers: this.authHeaders() });
      };

      const response = await retryOperation(request, {
        retries: 3,
        minTimeout: 700,
        factor: 2
      });

      return { success: true, data: response?.data || {} };
    } catch (error) {
      this.logger.error(`Google SecOps: searchDetections failed - ${error.message}`);
      return this.formatHttpError(error);
    }
  }

  // Error formatter
  formatHttpError(error) {
    if (error?.code === 'MISSING_CONFIG') {
      return { success: false, error: error.message };
    }
    const status = error?.response?.status;
    const msg = error?.response?.data?.error?.message || error.message || 'Request failed';
    return {
      success: false,
      error: `HTTP ${status || 'Error'}: ${msg}`,
      details: error?.response?.data || undefined
    };
  }
}
