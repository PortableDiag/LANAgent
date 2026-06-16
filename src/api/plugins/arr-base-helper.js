import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import axios from 'axios';
import NodeCache from 'node-cache';

/**
 * ArrBasePlugin - Shared base class for all *arr service plugins
 * (Radarr, Sonarr, Lidarr, Readarr, Prowlarr)
 *
 * Provides common functionality:
 * - API request handling with X-Api-Key auth
 * - Health, queue, calendar, history, command, status endpoints
 * - Credential loading from PluginSettings / env vars
 * - Response caching with NodeCache
 * - AI parameter extraction
 */
export class ArrBasePlugin extends BasePlugin {
  constructor(agent, { name, version, description, apiVersion, envPrefix, commands, intents }) {
    super(agent);
    this.name = name;
    this.version = version || '1.0.0';
    this.description = description;

    this.apiVersion = apiVersion; // e.g. 'v3' or 'v1'
    this.envPrefix = envPrefix;   // e.g. 'RADARR' -> RADARR_URL, RADARR_API_KEY

    this.requiredCredentials = [
      { key: 'url', label: `${name} Server URL`, envVar: `${envPrefix}_URL`, required: true },
      { key: 'apiKey', label: `${name} API Key`, envVar: `${envPrefix}_API_KEY`, required: true }
    ];

    this.commands = commands || [];
    this.intents = intents || {};

    this.config = {
      url: null,
      apiKey: null,
      timeout: 15000,
      cacheTimeout: 120
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 120, checkperiod: 30 });
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      try {
        const credentials = await this.loadCredentials(this.requiredCredentials);
        this.config.url = credentials.url?.replace(/\/+$/, '');
        this.config.apiKey = credentials.apiKey;
      } catch (credError) {
        if (credError.message.includes('Missing required credentials')) {
          this.logger.warn(`${this.name}: credentials not configured — plugin disabled`);
          this.needsConfiguration = true;
          return;
        }
        throw credError;
      }

      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        const { url, apiKey, ...otherConfig } = savedConfig;
        Object.assign(this.config, otherConfig);
      }

      // Test connectivity
      const health = await this._apiGet('/health');
      if (health === null) {
        this.logger.warn(`${this.name}: could not reach server at ${this.config.url} — check config`);
      } else {
        this.logger.info(`${this.name}: connected to ${this.config.url}`);
      }

      const { url, apiKey, ...configToCache } = this.config;
      await PluginSettings.setCached(this.name, 'config', configToCache);

      this.initialized = true;
      this.logger.info(`${this.name} plugin initialized`);
    } catch (error) {
      this.logger.error(`${this.name} initialization failed:`, error);
      throw error;
    }
  }

  // ─── Core API Methods ───

  /**
   * Make an authenticated API request to the *arr service
   */
  async _apiRequest(method, path, data = null, params = null) {
    if (!this.config.url || !this.config.apiKey) {
      throw new Error(`${this.name} is not configured. Set URL and API key in plugin settings.`);
    }

    const url = `${this.config.url}/api/${this.apiVersion}${path}`;

    try {
      const response = await retryOperation(async () => {
        return await axios({
          method,
          url,
          data,
          params,
          headers: { 'X-Api-Key': this.config.apiKey },
          timeout: this.config.timeout
        });
      }, { retries: 2, context: `${this.name} ${method.toUpperCase()} ${path}` });

      return response.data;
    } catch (error) {
      // Extract clean error message from axios errors (which have circular references)
      const status = error.response?.status;
      const serverMsg = error.response?.data?.message || error.response?.data?.error;
      const msg = serverMsg
        ? `${this.name} API error (${status}): ${serverMsg}`
        : error.code === 'ECONNREFUSED' ? `${this.name}: connection refused at ${this.config.url}`
        : error.code === 'ETIMEDOUT' || error.message?.includes('timeout') ? `${this.name}: request timed out`
        : `${this.name} API error: ${error.message || 'unknown error'}`;
      throw new Error(msg);
    }
  }

  async _apiGet(path, params = null) {
    try {
      return await this._apiRequest('get', path, null, params);
    } catch {
      return null;
    }
  }

  async _apiPost(path, data = null) {
    return await this._apiRequest('post', path, data);
  }

  async _apiPut(path, data) {
    return await this._apiRequest('put', path, data);
  }

  async _apiDelete(path, params = null) {
    return await this._apiRequest('delete', path, null, params);
  }

  // ─── Cached API helper ───

  async _cachedGet(cacheKey, path, params = null, ttl = null) {
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const data = await this._apiRequest('get', path, null, params);
    this.cache.set(cacheKey, data, ttl || this.config.cacheTimeout);
    return data;
  }

  // ─── Common *arr endpoints ───

  async getHealth() {
    const data = await this._cachedGet('health', '/health', null, 60);
    if (!data) return { success: false, error: `Could not reach ${this.name}` };

    const issues = Array.isArray(data) ? data : [];
    return {
      success: true,
      healthy: issues.length === 0,
      issues: issues.map(i => ({
        type: i.type,
        message: i.message,
        source: i.source,
        wikiUrl: i.wikiUrl
      })),
      result: issues.length === 0
        ? `${this.name} is healthy — no issues detected.`
        : `${this.name} has ${issues.length} issue(s):\n${issues.map(i => `- [${i.type}] ${i.message}`).join('\n')}`
    };
  }

  async getSystemStatus() {
    const data = await this._cachedGet('status', '/system/status', null, 300);
    if (!data) return { success: false, error: `Could not reach ${this.name}` };

    return {
      success: true,
      version: data.version,
      buildTime: data.buildTime,
      startTime: data.startTime,
      appName: data.appName,
      osName: data.osName,
      branch: data.branch,
      result: `${data.appName || this.name} v${data.version} on ${data.osName || 'unknown OS'}, branch: ${data.branch || 'unknown'}`
    };
  }

  async getDiskSpace() {
    const data = await this._cachedGet('rootfolder', '/rootfolder');
    if (!data) return { success: false, error: `Could not fetch disk info from ${this.name}` };

    const folders = Array.isArray(data) ? data : [];
    return {
      success: true,
      folders: folders.map(f => ({
        path: f.path,
        freeSpace: f.freeSpace,
        freeSpaceGB: f.freeSpace ? (f.freeSpace / 1073741824).toFixed(1) : null,
        totalSpace: f.totalSpace,
        accessible: f.accessible !== false
      })),
      result: folders.map(f => {
        const free = f.freeSpace ? `${(f.freeSpace / 1073741824).toFixed(1)} GB free` : 'unknown';
        return `${f.path}: ${free}`;
      }).join('\n')
    };
  }

  async getQueue(page = 1, pageSize = 20) {
    const data = await this._cachedGet(`queue_${page}_${pageSize}`, '/queue', {
      page, pageSize, sortKey: 'progress', sortDirection: 'ascending'
    }, 30);

    if (!data) return { success: false, error: `Could not fetch queue from ${this.name}` };

    const records = data.records || [];
    return {
      success: true,
      totalRecords: data.totalRecords || 0,
      records: records.map(r => ({
        id: r.id,
        title: r.title,
        status: r.status,
        progress: r.sizeleft && r.size ? ((1 - r.sizeleft / r.size) * 100).toFixed(1) : null,
        size: r.size,
        sizeleft: r.sizeleft,
        estimatedCompletionTime: r.estimatedCompletionTime,
        indexer: r.indexer,
        downloadClient: r.downloadClient
      })),
      result: records.length === 0
        ? `${this.name} download queue is empty.`
        : `${this.name} queue (${data.totalRecords} items):\n${records.map(r => {
          const pct = r.sizeleft && r.size ? ((1 - r.sizeleft / r.size) * 100).toFixed(0) : '?';
          return `- ${r.title} — ${pct}% (${r.status})`;
        }).join('\n')}`
    };
  }

  async getCalendar(startDate = null, endDate = null) {
    const now = new Date();
    const start = startDate || new Date(now.getTime() - 7 * 86400000).toISOString();
    const end = endDate || new Date(now.getTime() + 30 * 86400000).toISOString();

    const data = await this._cachedGet(`calendar_${start}_${end}`, '/calendar', {
      start, end
    }, 120);

    return { success: true, items: Array.isArray(data) ? data : [], _raw: data };
  }

  async getHistory(page = 1, pageSize = 20) {
    const data = await this._cachedGet(`history_${page}`, '/history', {
      page, pageSize, sortKey: 'date', sortDirection: 'descending'
    }, 60);

    if (!data) return { success: false, error: `Could not fetch history from ${this.name}` };

    return {
      success: true,
      totalRecords: data.totalRecords || 0,
      records: (data.records || []).slice(0, pageSize)
    };
  }

  async executeArrCommand(commandName, body = {}) {
    const result = await this._apiPost('/command', { name: commandName, ...body });
    this.cache.flushAll();
    return {
      success: true,
      command: commandName,
      id: result?.id,
      status: result?.status,
      result: `${this.name}: command '${commandName}' triggered (id: ${result?.id || 'unknown'})`
    };
  }

  // ─── Notification Management ───

  async getNotifications(filter = {}) {
    const data = await this._cachedGet('notifications', '/notification', filter, 60);
    if (!data) return { success: false, error: `Could not fetch notifications from ${this.name}` };

    const notifications = Array.isArray(data) ? data : [];
    return {
      success: true,
      notifications: notifications.map(n => ({
        id: n.id,
        name: n.name,
        implementation: n.implementation,
        onGrab: n.onGrab,
        onDownload: n.onDownload,
        onUpgrade: n.onUpgrade,
        onHealthIssue: n.onHealthIssue
      })),
      result: notifications.length === 0
        ? `${this.name}: no notifications configured.`
        : `${this.name} notifications:\n${notifications.map(n => `- ${n.name} (${n.implementation})`).join('\n')}`
    };
  }

  async createNotification(data) {
    if (!data || !data.name || !data.implementation) {
      return { success: false, error: 'name and implementation are required for creating a notification' };
    }
    const result = await this._apiPost('/notification', data);
    this.cache.del('notifications');
    return {
      success: true,
      notificationId: result?.id,
      result: `${this.name}: notification '${data.name}' created (id: ${result?.id || 'unknown'})`
    };
  }

  async deleteNotification(data) {
    if (!data?.id) {
      return { success: false, error: 'notification id is required' };
    }
    await this._apiDelete(`/notification/${data.id}`);
    this.cache.del('notifications');
    return {
      success: true,
      result: `${this.name}: notification ${data.id} deleted`
    };
  }

  /**
   * Filter notifications based on criteria
   * @param {Object} criteria - The filter criteria
   * @returns {Promise<Object>} - Filtered notifications
   */
  async filterNotifications(criteria) {
    const notifications = await this.getNotifications(criteria);
    if (!notifications.success) {
      return { success: false, error: notifications.error };
    }

    const filtered = notifications.notifications.filter(notification => {
      let matches = true;
      if (criteria.type && notification.implementation !== criteria.type) {
        matches = false;
      }
      if (criteria.status && !notification[criteria.status]) {
        matches = false;
      }
      if (criteria.startDate || criteria.endDate) {
        const notificationDate = new Date(notification.date);
        if (criteria.startDate && notificationDate < new Date(criteria.startDate)) {
          matches = false;
        }
        if (criteria.endDate && notificationDate > new Date(criteria.endDate)) {
          matches = false;
        }
      }
      return matches;
    });

    return {
      success: true,
      notifications: filtered,
      result: filtered.length === 0
        ? `${this.name}: no notifications match the criteria.`
        : `${this.name} filtered notifications:\n${filtered.map(n => `- ${n.name} (${n.implementation})`).join('\n')}`
    };
  }

  // ─── AI Parameter Extraction ───

  async extractParameters(input, action) {
    if (!this.agent.providerManager) return {};

    const cmd = this.commands.find(c => c.command === action);
    const usageHint = cmd ? `Expected format: ${cmd.usage}` : '';

    const prompt = `Extract parameters from user input for the ${this.name} plugin.
Action: ${action}
User said: "${input}"
${usageHint}

Return ONLY valid JSON with the extracted parameters. No explanation.`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, {
        temperature: 0.2,
        maxTokens: 300
      });
      return safeJsonParse(response.content, {});
    } catch (error) {
      this.logger.warn(`Parameter extraction failed for ${action}:`, error.message);
      return {};
    }
  }

  // ─── Common execute wrapper ───

  // Actions that don't require parameter extraction (no user-supplied names/queries)
  static NO_PARAM_ACTIONS = new Set([
    'get_authors', 'get_movies', 'get_series', 'get_artists',
    'get_queue', 'get_health', 'get_status', 'get_calendar',
    'get_wanted', 'get_history', 'get_indexers', 'get_stats',
    'refresh', 'search_downloads', 'get_notifications', 'check_updates'
  ]);

  async _executeAction(params, actionHandlers) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: this.commands.map(c => c.command)
      }
    });

    if (params.needsParameterExtraction && this.agent.providerManager
        && !ArrBasePlugin.NO_PARAM_ACTIONS.has(action)) {
      const extracted = await this.extractParameters(params.originalInput || params.input, action);
      Object.assign(data, extracted);
    }

    // Handle common base actions before plugin-specific handlers
    if (action === 'check_updates') return await this.checkForUpdate();

    const handler = actionHandlers[action];
    if (!handler) throw new Error(`Unknown action: ${action}`);

    try {
      return await handler.call(this, data);
    } catch (error) {
      this.logger.error(`${this.name} ${action} failed:`, error);
      return { success: false, error: error.message };
    }
  }

  // ─── Test Connection ───

  async testConnection() {
    if (!this.config.url || !this.config.apiKey) {
      return { success: false, message: `${this.name} is not configured. Set URL and API key in plugin settings.` };
    }

    try {
      const status = await this._apiRequest('get', '/system/status');
      return {
        success: true,
        message: `Connected to ${status.appName || this.name} v${status.version} on ${status.osName || 'unknown OS'}`
      };
    } catch (error) {
      const hint = error.message.includes('ECONNREFUSED') ? ' — is the service running?'
        : error.message.includes('401') || error.message.includes('403') ? ' — check your API key'
        : '';
      return { success: false, message: `Cannot reach ${this.name} at ${this.config.url}${hint}` };
    }
  }

  // ─── Update Check ───

  /**
   * Check for available updates by comparing installed version against the *arr API's update endpoint.
   * Falls back to GitHub releases if the API endpoint is unavailable.
   * @returns {{ success, currentVersion, latestVersion, updateAvailable, isMajor, releaseUrl, changelog }}
   */
  async checkForUpdate() {
    try {
      const status = await this._apiGet('/system/status');
      if (!status?.version) return { success: false, error: `Could not get ${this.name} version` };

      const currentVersion = status.version;
      let latestVersion = null;
      let releaseUrl = null;
      let changelog = null;

      // Try the built-in update endpoint first (most *arr apps have this)
      const updates = await this._apiGet('/update');
      if (Array.isArray(updates) && updates.length > 0) {
        const latest = updates[0];
        latestVersion = latest.version;
        releaseUrl = latest.releaseUrl || null;
        changelog = (latest.changes?.new || []).slice(0, 5).map(c => c.replace(/^- ?/, '')).join('; ') || null;
      }

      // Fallback to GitHub API
      if (!latestVersion) {
        const ghRepo = this.name.charAt(0).toUpperCase() + this.name.slice(1); // prowlarr -> Prowlarr
        try {
          const ghRes = await axios.get(`https://api.github.com/repos/${ghRepo}/${ghRepo}/releases/latest`, {
            timeout: 10000, headers: { 'Accept': 'application/vnd.github.v3+json' }
          });
          latestVersion = ghRes.data?.tag_name?.replace(/^v/, '') || null;
          releaseUrl = ghRes.data?.html_url || null;
        } catch { /* GitHub rate limit or repo name mismatch — skip */ }
      }

      if (!latestVersion) return { success: true, currentVersion, latestVersion: null, updateAvailable: false, result: `${this.name} v${currentVersion} — could not check for updates` };

      const [curMajor] = currentVersion.split('.').map(Number);
      const [latMajor] = latestVersion.split('.').map(Number);
      const updateAvailable = latestVersion !== currentVersion;
      const isMajor = latMajor > curMajor;

      return {
        success: true,
        currentVersion,
        latestVersion,
        updateAvailable,
        isMajor,
        releaseUrl,
        changelog,
        result: updateAvailable
          ? `${this.name}: update available — v${currentVersion} → v${latestVersion}${isMajor ? ' (MAJOR)' : ''}${changelog ? '\nChanges: ' + changelog : ''}`
          : `${this.name} v${currentVersion} — up to date`
      };
    } catch (err) {
      return { success: false, error: `${this.name} update check failed: ${err.message}` };
    }
  }

  /**
   * Check all configured *arr plugins for updates. Static helper used by scheduler.
   * @param {object} agent - The agent instance
   * @returns {{ updates: Array, summary: string }}
   */
  static async checkAllArrUpdates(agent) {
    const arrPluginNames = ['prowlarr', 'radarr', 'sonarr', 'lidarr', 'readarr'];
    const updates = [];

    for (const name of arrPluginNames) {
      const plugin = agent.apiManager?.apis?.get(name)?.instance;
      if (!plugin?.initialized) continue;

      try {
        const result = await plugin.checkForUpdate();
        if (result.success && result.updateAvailable) {
          updates.push(result);
        }
      } catch { /* skip unavailable services */ }
    }

    const summary = updates.length === 0
      ? null
      : `🔄 *ARR Service Updates Available*\n\n${updates.map(u => {
          const majorTag = u.isMajor ? ' ⚠️ MAJOR' : '';
          return `• *${u.currentVersion.split('.')[0] < u.latestVersion.split('.')[0] ? '⚠️ ' : ''}${u.result}*`;
        }).join('\n')}`;

    return { updates, summary };
  }

  // ─── Cleanup ───

  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);
    this.cache.flushAll();
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
