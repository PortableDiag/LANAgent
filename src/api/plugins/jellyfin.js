import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';
import { PluginSettings } from '../../models/PluginSettings.js';
import { decrypt } from '../../utils/encryption.js';

export default class JellyfinPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'jellyfin';
    this.version = '1.0.0';
    this.description = 'Manage your Jellyfin media server — browse libraries, search media, manage users, control playback, playlists, scheduled tasks, and more';

    this.requiredCredentials = [
      { key: 'url', label: 'Jellyfin Server URL', envVar: 'JELLYFIN_URL', required: true },
      { key: 'apiKey', label: 'Jellyfin API Key', envVar: 'JELLYFIN_API_KEY', required: true }
    ];

    this.config = {
      url: null,
      apiKey: null,
      timeout: 15000
    };

    this.cache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

    this.commands = [
      // ─── System ───
      {
        command: 'get_server_info',
        description: 'Get Jellyfin server information including version, OS, and architecture',
        usage: 'get_server_info()',
        examples: [
          'jellyfin server info',
          'what version of jellyfin is running',
          'jellyfin system status',
          'tell me about the jellyfin server'
        ]
      },
      {
        command: 'restart_server',
        description: 'Restart the Jellyfin server',
        usage: 'restart_server()',
        examples: [
          'restart jellyfin',
          'reboot the jellyfin server',
          'jellyfin needs a restart'
        ]
      },
      {
        command: 'shutdown_server',
        description: 'Shut down the Jellyfin server',
        usage: 'shutdown_server()',
        examples: [
          'shut down jellyfin',
          'stop the jellyfin server',
          'turn off jellyfin'
        ]
      },
      {
        command: 'get_activity_log',
        description: 'Get recent Jellyfin activity log entries',
        usage: 'get_activity_log({ limit: 20 })',
        examples: [
          'show jellyfin activity log',
          'what happened on jellyfin recently',
          'jellyfin recent activity',
          'jellyfin log entries'
        ]
      },
      {
        command: 'get_scheduled_tasks',
        description: 'List all scheduled tasks on the Jellyfin server',
        usage: 'get_scheduled_tasks()',
        examples: [
          'show jellyfin scheduled tasks',
          'what tasks are scheduled on jellyfin',
          'list jellyfin tasks',
          'jellyfin task list'
        ]
      },
      {
        command: 'run_scheduled_task',
        description: 'Start a scheduled task on the Jellyfin server',
        usage: 'run_scheduled_task({ taskId: "abc123" })',
        examples: [
          'run the library scan task on jellyfin',
          'start a jellyfin task',
          'trigger jellyfin scheduled task',
          'execute jellyfin task'
        ]
      },
      {
        command: 'stop_scheduled_task',
        description: 'Stop a running scheduled task on the Jellyfin server',
        usage: 'stop_scheduled_task({ taskId: "abc123" })',
        examples: [
          'stop the running jellyfin task',
          'cancel jellyfin task',
          'abort the jellyfin scan'
        ]
      },

      // ─── Libraries ───
      {
        command: 'get_libraries',
        description: 'List all media libraries configured in Jellyfin',
        usage: 'get_libraries()',
        examples: [
          'show jellyfin libraries',
          'what libraries are in jellyfin',
          'list my jellyfin media libraries',
          'jellyfin library list'
        ]
      },
      {
        command: 'refresh_library',
        description: 'Scan and refresh all Jellyfin libraries or a specific library',
        usage: 'refresh_library({ libraryId: "abc123" })',
        examples: [
          'scan jellyfin library',
          'refresh jellyfin libraries',
          'rescan my jellyfin media',
          'update jellyfin library',
          'jellyfin library scan'
        ]
      },

      // ─── Items / Media ───
      {
        command: 'get_items',
        description: 'Browse media items in Jellyfin with filters (movies, series, music, etc.)',
        usage: 'get_items({ type: "Movie", limit: 20 })',
        examples: [
          'show all movies in jellyfin',
          'list my jellyfin tv shows',
          'what music is in jellyfin',
          'browse jellyfin media',
          'how many movies are in jellyfin',
          'show my jellyfin collection'
        ]
      },
      {
        command: 'get_item_details',
        description: 'Get detailed information about a specific media item in Jellyfin',
        usage: 'get_item_details({ itemId: "abc123" })',
        examples: [
          'get details for that jellyfin item',
          'show me info about this movie in jellyfin',
          'jellyfin item details'
        ]
      },
      {
        command: 'get_latest_media',
        description: 'Get the latest added media in Jellyfin',
        usage: 'get_latest_media({ type: "Movie", limit: 10 })',
        examples: [
          'what was recently added to jellyfin',
          'latest additions to jellyfin',
          'new stuff on jellyfin',
          'recently added movies on jellyfin',
          'newest media in jellyfin'
        ]
      },
      {
        command: 'search_media',
        description: 'Search for media across all Jellyfin libraries',
        usage: 'search_media({ query: "Inception" })',
        examples: [
          'search jellyfin for Inception',
          'find The Matrix on jellyfin',
          'look up Breaking Bad in jellyfin',
          'search my jellyfin library',
          'is Dune on jellyfin',
          'do I have Interstellar on jellyfin'
        ]
      },
      {
        command: 'delete_item',
        description: 'Delete a media item from the Jellyfin library',
        usage: 'delete_item({ itemId: "abc123" })',
        examples: [
          'delete that item from jellyfin',
          'remove this movie from jellyfin',
          'jellyfin delete item'
        ]
      },
      {
        command: 'refresh_item',
        description: 'Refresh metadata for a specific item in Jellyfin',
        usage: 'refresh_item({ itemId: "abc123" })',
        examples: [
          'refresh metadata for that jellyfin item',
          'update the metadata in jellyfin',
          'rescan this item in jellyfin'
        ]
      },

      // ─── TV Shows ───
      {
        command: 'get_seasons',
        description: 'Get all seasons for a TV series in Jellyfin',
        usage: 'get_seasons({ seriesId: "abc123" })',
        examples: [
          'show seasons for this series in jellyfin',
          'how many seasons does this show have on jellyfin',
          'jellyfin seasons list'
        ]
      },
      {
        command: 'get_episodes',
        description: 'Get episodes for a TV series or season in Jellyfin',
        usage: 'get_episodes({ seriesId: "abc123", seasonId: "def456" })',
        examples: [
          'show episodes for this season in jellyfin',
          'list episodes on jellyfin',
          'what episodes are available on jellyfin'
        ]
      },
      {
        command: 'get_next_up',
        description: 'Get next up episodes to watch in Jellyfin',
        usage: 'get_next_up({ limit: 10 })',
        examples: [
          'what should I watch next on jellyfin',
          'jellyfin next up',
          'next episodes to watch',
          'continue watching on jellyfin',
          'what shows have new episodes on jellyfin'
        ]
      },

      // ─── Users ───
      {
        command: 'get_users',
        description: 'List all Jellyfin user accounts',
        usage: 'get_users()',
        examples: [
          'list jellyfin users',
          'who has access to jellyfin',
          'show all jellyfin accounts',
          'jellyfin user list'
        ]
      },
      {
        command: 'get_user',
        description: 'Get details for a specific Jellyfin user',
        usage: 'get_user({ userId: "abc123" })',
        examples: [
          'show jellyfin user details',
          'get info about this jellyfin user'
        ]
      },
      {
        command: 'create_user',
        description: 'Create a new Jellyfin user account',
        usage: 'create_user({ name: "John", password: "pass123" })',
        examples: [
          'create a new jellyfin user',
          'add a user to jellyfin',
          'make a new jellyfin account',
          'set up a jellyfin user for John'
        ]
      },
      {
        command: 'delete_user',
        description: 'Delete a Jellyfin user account',
        usage: 'delete_user({ userId: "abc123" })',
        examples: [
          'delete a jellyfin user',
          'remove user from jellyfin',
          'delete that jellyfin account'
        ]
      },
      {
        command: 'update_user_password',
        description: 'Change a Jellyfin user password',
        usage: 'update_user_password({ userId: "abc123", newPassword: "newpass" })',
        examples: [
          'change jellyfin user password',
          'reset password for jellyfin user',
          'update jellyfin password'
        ]
      },

      // ─── Sessions / Playback ───
      {
        command: 'get_sessions',
        description: 'Get all active Jellyfin playback sessions',
        usage: 'get_sessions()',
        examples: [
          'who is watching jellyfin',
          'show active jellyfin sessions',
          'what is playing on jellyfin',
          'jellyfin now playing',
          'current jellyfin streams',
          'is anyone using jellyfin'
        ]
      },
      {
        command: 'send_play_command',
        description: 'Send a playback command (play, pause, stop, next, previous) to a Jellyfin session',
        usage: 'send_play_command({ sessionId: "abc123", command: "Pause" })',
        examples: [
          'pause jellyfin playback',
          'stop playing on jellyfin',
          'resume playback on jellyfin',
          'skip to next on jellyfin',
          'jellyfin play command'
        ]
      },
      {
        command: 'send_message',
        description: 'Send a message to a Jellyfin session/client',
        usage: 'send_message({ sessionId: "abc123", text: "Hello!", timeoutMs: 5000 })',
        examples: [
          'send a message on jellyfin',
          'message the jellyfin client',
          'display a message on jellyfin'
        ]
      },

      // ─── Playlists ───
      {
        command: 'get_playlists',
        description: 'List all playlists in Jellyfin',
        usage: 'get_playlists()',
        examples: [
          'show jellyfin playlists',
          'list my playlists on jellyfin',
          'what playlists are on jellyfin'
        ]
      },
      {
        command: 'create_playlist',
        description: 'Create a new playlist in Jellyfin',
        usage: 'create_playlist({ name: "My Playlist", ids: ["item1", "item2"] })',
        examples: [
          'create a jellyfin playlist',
          'make a new playlist on jellyfin',
          'add a playlist to jellyfin'
        ]
      },
      {
        command: 'add_to_playlist',
        description: 'Add items to a Jellyfin playlist',
        usage: 'add_to_playlist({ playlistId: "abc123", ids: ["item1"] })',
        examples: [
          'add to jellyfin playlist',
          'put this in the jellyfin playlist',
          'add items to playlist on jellyfin'
        ]
      },
      {
        command: 'remove_from_playlist',
        description: 'Remove items from a Jellyfin playlist',
        usage: 'remove_from_playlist({ playlistId: "abc123", entryIds: ["entry1"] })',
        examples: [
          'remove from jellyfin playlist',
          'take this off the jellyfin playlist',
          'delete item from playlist on jellyfin'
        ]
      },

      // ─── Plugins / Packages ───
      {
        command: 'get_installed_plugins',
        description: 'List all plugins installed on the Jellyfin server',
        usage: 'get_installed_plugins()',
        examples: [
          'what plugins are installed on jellyfin',
          'list jellyfin plugins',
          'show jellyfin server plugins',
          'jellyfin plugin list'
        ]
      },
      {
        command: 'get_available_packages',
        description: 'List available packages/plugins that can be installed on Jellyfin',
        usage: 'get_available_packages()',
        examples: [
          'what plugins can I install on jellyfin',
          'available jellyfin packages',
          'show installable jellyfin plugins',
          'browse jellyfin plugin catalog'
        ]
      }
    ];

    this.intents = {
      serverInfo: {
        name: 'Jellyfin Server Info',
        description: 'Get Jellyfin server information and status',
        action: 'get_server_info',
        examples: ['jellyfin server info', 'jellyfin status', 'what version is jellyfin', 'jellyfin system info']
      },
      getLibraries: {
        name: 'Jellyfin Libraries',
        description: 'List all Jellyfin media libraries',
        action: 'get_libraries',
        examples: ['jellyfin libraries', 'my media libraries', 'list jellyfin libraries', 'what libraries do I have']
      },
      refreshLibrary: {
        name: 'Refresh Jellyfin Library',
        description: 'Scan and refresh Jellyfin media libraries',
        action: 'refresh_library',
        examples: ['scan jellyfin library', 'refresh jellyfin', 'rescan media', 'update jellyfin library']
      },
      browseMedia: {
        name: 'Browse Jellyfin Media',
        description: 'List media items in Jellyfin libraries',
        action: 'get_items',
        examples: ['show jellyfin movies', 'list my shows on jellyfin', 'browse jellyfin', 'what media is on jellyfin']
      },
      searchMedia: {
        name: 'Search Jellyfin',
        description: 'Search for media across Jellyfin libraries',
        action: 'search_media',
        examples: ['search jellyfin', 'find on jellyfin', 'look up in jellyfin', 'is this on jellyfin']
      },
      latestMedia: {
        name: 'Latest Jellyfin Additions',
        description: 'Get recently added media in Jellyfin',
        action: 'get_latest_media',
        examples: ['recently added to jellyfin', 'new on jellyfin', 'latest jellyfin media', 'whats new on jellyfin']
      },
      nextUp: {
        name: 'Jellyfin Next Up',
        description: 'Get next episodes to watch in Jellyfin',
        action: 'get_next_up',
        examples: ['next up on jellyfin', 'what to watch next', 'continue watching', 'next episodes jellyfin']
      },
      listUsers: {
        name: 'Jellyfin Users',
        description: 'List Jellyfin user accounts',
        action: 'get_users',
        examples: ['jellyfin users', 'who has jellyfin access', 'list jellyfin accounts', 'show jellyfin users']
      },
      createUser: {
        name: 'Create Jellyfin User',
        description: 'Create a new user account on Jellyfin',
        action: 'create_user',
        examples: ['create jellyfin user', 'add user to jellyfin', 'new jellyfin account', 'set up jellyfin user']
      },
      activeSessions: {
        name: 'Jellyfin Active Sessions',
        description: 'Check who is currently watching on Jellyfin',
        action: 'get_sessions',
        examples: ['who is watching jellyfin', 'active jellyfin sessions', 'jellyfin now playing', 'current streams']
      },
      playbackControl: {
        name: 'Jellyfin Playback Control',
        description: 'Control playback on Jellyfin (play, pause, stop)',
        action: 'send_play_command',
        examples: ['pause jellyfin', 'stop jellyfin playback', 'resume playing on jellyfin', 'jellyfin play control']
      },
      playlists: {
        name: 'Jellyfin Playlists',
        description: 'List playlists on Jellyfin',
        action: 'get_playlists',
        examples: ['jellyfin playlists', 'my playlists on jellyfin', 'show playlists', 'list jellyfin playlists']
      },
      scheduledTasks: {
        name: 'Jellyfin Scheduled Tasks',
        description: 'List scheduled tasks on Jellyfin',
        action: 'get_scheduled_tasks',
        examples: ['jellyfin tasks', 'scheduled tasks', 'jellyfin task list', 'what tasks are running']
      },
      activityLog: {
        name: 'Jellyfin Activity Log',
        description: 'View Jellyfin activity log',
        action: 'get_activity_log',
        examples: ['jellyfin activity', 'jellyfin log', 'what happened on jellyfin', 'jellyfin events']
      },
      installedPlugins: {
        name: 'Jellyfin Plugins',
        description: 'List installed Jellyfin plugins',
        action: 'get_installed_plugins',
        examples: ['jellyfin plugins', 'installed plugins', 'what plugins on jellyfin', 'jellyfin addons']
      }
    };
  }

  async initialize() {
    try {
      const credentials = await this.loadCredentials(this.requiredCredentials);
      this.config.url = credentials.url?.replace(/\/+$/, '');
      this.config.apiKey = credentials.apiKey;
    } catch (error) {
      // Try loading from PluginSettings directly
      await this._loadStoredCredentials();
    }

    if (!this.config.url || !this.config.apiKey) {
      logger.warn('Jellyfin plugin: URL or API key not configured');
      this.needsConfiguration = true;
      return;
    }

    logger.info(`Jellyfin plugin initialized: ${this.config.url}`);
  }

  async _loadStoredCredentials() {
    try {
      const record = await PluginSettings.findOne({
        pluginName: this.name,
        settingsKey: 'credentials'
      });
      if (record?.settingsValue) {
        if (record.settingsValue.url) {
          try { this.config.url = decrypt(record.settingsValue.url); } catch { this.config.url = record.settingsValue.url; }
        }
        if (record.settingsValue.apiKey) {
          try { this.config.apiKey = decrypt(record.settingsValue.apiKey); } catch { this.config.apiKey = record.settingsValue.apiKey; }
        }
      }
    } catch (error) {
      logger.error('Jellyfin: Error loading stored credentials:', error.message);
    }
  }

  // ─── HTTP Helper ───

  async _api(method, path, data = null, params = {}) {
    if (!this.config.url || !this.config.apiKey) {
      throw new Error('Jellyfin URL or API key not configured. Set them in the plugin settings.');
    }

    const url = `${this.config.url}${path}`;
    const headers = {
      'Authorization': `MediaBrowser Token="${this.config.apiKey}"`,
      'Content-Type': 'application/json'
    };

    try {
      const response = await retryOperation(async () => {
        return axios({
          method,
          url,
          data,
          params,
          headers,
          timeout: this.config.timeout
        });
      }, { retries: 2, context: 'jellyfin-api' });

      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const msg = error.response?.data?.message || error.response?.data || error.message;
      logger.error(`Jellyfin API error (${method.toUpperCase()} ${path}):`, typeof msg === 'string' ? msg : error.message);
      throw new Error(`Jellyfin API error${status ? ` (${status})` : ''}: ${typeof msg === 'string' ? msg : error.message}`);
    }
  }

  async _cachedGet(cacheKey, path, params = {}, ttl = null) {
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const data = await this._api('get', path, null, params);
    this.cache.set(cacheKey, data, ttl || 120);
    return data;
  }

  // ─── Admin User Resolution ───

  async _getAdminUserId() {
    const cached = this.cache.get('adminUserId');
    if (cached) return cached;

    const users = await this._api('get', '/Users');
    const admin = users.find(u => u.Policy?.IsAdministrator) || users[0];
    if (admin) {
      this.cache.set('adminUserId', admin.Id, 600);
      return admin.Id;
    }
    return null;
  }

  // ─── Execute Router ───

  async execute(params) {
    const { action, ...data } = params;

    if (!this.config.url || !this.config.apiKey) {
      return { success: false, error: 'Jellyfin URL or API key not configured. Please set them in the plugin settings.' };
    }

    try {
      switch (action) {
        // System
        case 'get_server_info':       return await this.getServerInfo();
        case 'restart_server':        return await this.restartServer();
        case 'shutdown_server':       return await this.shutdownServer();
        case 'get_activity_log':      return await this.getActivityLog(data);
        case 'get_scheduled_tasks':   return await this.getScheduledTasks();
        case 'run_scheduled_task':    return await this.runScheduledTask(data);
        case 'stop_scheduled_task':   return await this.stopScheduledTask(data);

        // Libraries
        case 'get_libraries':         return await this.getLibraries();
        case 'refresh_library':       return await this.refreshLibrary(data);

        // Items / Media
        case 'get_items':             return await this.getItems(data);
        case 'get_item_details':      return await this.getItemDetails(data);
        case 'get_latest_media':      return await this.getLatestMedia(data);
        case 'search_media':          return await this.searchMedia(data);
        case 'delete_item':           return await this.deleteItem(data);
        case 'refresh_item':          return await this.refreshItem(data);

        // TV Shows
        case 'get_seasons':           return await this.getSeasons(data);
        case 'get_episodes':          return await this.getEpisodes(data);
        case 'get_next_up':           return await this.getNextUp(data);

        // Users
        case 'get_users':             return await this.getUsers();
        case 'get_user':              return await this.getUser(data);
        case 'create_user':           return await this.createUser(data);
        case 'delete_user':           return await this.deleteUser(data);
        case 'update_user_password':  return await this.updateUserPassword(data);

        // Sessions / Playback
        case 'get_sessions':          return await this.getSessions();
        case 'send_play_command':     return await this.sendPlayCommand(data);
        case 'send_message':          return await this.sendMessage(data);

        // Playlists
        case 'get_playlists':         return await this.getPlaylists();
        case 'create_playlist':       return await this.createPlaylist(data);
        case 'add_to_playlist':       return await this.addToPlaylist(data);
        case 'remove_from_playlist':  return await this.removeFromPlaylist(data);

        // Plugins / Packages
        case 'get_installed_plugins': return await this.getInstalledPlugins();
        case 'get_available_packages': return await this.getAvailablePackages();

        default:
          return {
            success: false,
            error: `Unknown action: ${action}. Available: ${this.commands.map(c => c.command).join(', ')}`
          };
      }
    } catch (error) {
      logger.error(`Jellyfin plugin error (${action}):`, error.message);
      return { success: false, error: error.message };
    }
  }

  // ═══════════════════════════════════════
  //  SYSTEM
  // ═══════════════════════════════════════

  async getServerInfo() {
    const info = await this._cachedGet('serverInfo', '/System/Info', {}, 300);
    return {
      success: true,
      data: info,
      result: [
        `Jellyfin Server: ${info.ServerName || 'Jellyfin'}`,
        `Version: ${info.Version}`,
        `OS: ${info.OperatingSystem} ${info.OperatingSystemDisplayName || ''}`,
        `Architecture: ${info.SystemArchitecture}`,
        `Has Pending Restart: ${info.HasPendingRestart ? 'Yes' : 'No'}`,
        info.LocalAddress ? `Local Address: ${info.LocalAddress}` : '',
        info.WanAddress ? `WAN Address: ${info.WanAddress}` : ''
      ].filter(Boolean).join('\n')
    };
  }

  async restartServer() {
    await this._api('post', '/System/Restart');
    return { success: true, result: 'Jellyfin server restart initiated.' };
  }

  async shutdownServer() {
    await this._api('post', '/System/Shutdown');
    return { success: true, result: 'Jellyfin server shutdown initiated.' };
  }

  async getActivityLog(data) {
    const limit = data.limit || 20;
    const result = await this._api('get', '/System/ActivityLog/Entries', null, {
      startIndex: 0,
      limit,
      ...(data.minDate ? { minDate: data.minDate } : {})
    });

    const items = result.Items || [];
    return {
      success: true,
      total: result.TotalRecordCount || items.length,
      entries: items.map(e => ({
        id: e.Id,
        name: e.Name,
        type: e.Type,
        date: e.Date,
        severity: e.Severity,
        userId: e.UserId
      })),
      result: items.length === 0
        ? 'No activity log entries found.'
        : `Jellyfin activity log (${items.length} entries):\n${items.map(e =>
          `- [${e.Severity || 'Info'}] ${new Date(e.Date).toLocaleString()}: ${e.Name}`
        ).join('\n')}`
    };
  }

  async getScheduledTasks() {
    const tasks = await this._cachedGet('scheduledTasks', '/ScheduledTasks', {}, 60);
    return {
      success: true,
      total: tasks.length,
      tasks: tasks.map(t => ({
        id: t.Id,
        name: t.Name,
        description: t.Description,
        state: t.State,
        category: t.Category,
        lastExecutionResult: t.LastExecutionResult?.Status
      })),
      result: `Jellyfin scheduled tasks (${tasks.length}):\n${tasks.map(t =>
        `- ${t.Name} [${t.State}]${t.LastExecutionResult ? ` (last: ${t.LastExecutionResult.Status})` : ''} — ${t.Category}`
      ).join('\n')}`
    };
  }

  async runScheduledTask(data) {
    this.validateParams(data, { taskId: { required: true, type: 'string' } });
    await this._api('post', `/ScheduledTasks/Running/${data.taskId}`);
    return { success: true, result: `Scheduled task ${data.taskId} started.` };
  }

  async stopScheduledTask(data) {
    this.validateParams(data, { taskId: { required: true, type: 'string' } });
    await this._api('delete', `/ScheduledTasks/Running/${data.taskId}`);
    return { success: true, result: `Scheduled task ${data.taskId} stopped.` };
  }

  // ═══════════════════════════════════════
  //  LIBRARIES
  // ═══════════════════════════════════════

  async getLibraries() {
    const folders = await this._cachedGet('libraries', '/Library/VirtualFolders', {}, 300);
    return {
      success: true,
      total: folders.length,
      libraries: folders.map(f => ({
        name: f.Name,
        itemId: f.ItemId,
        collectionType: f.CollectionType,
        locations: f.Locations,
        refreshStatus: f.RefreshStatus
      })),
      result: `Jellyfin libraries (${folders.length}):\n${folders.map(f =>
        `- ${f.Name} (${f.CollectionType || 'mixed'}) — ${f.Locations?.length || 0} location(s)`
      ).join('\n')}`
    };
  }

  async refreshLibrary(data) {
    if (data.libraryId) {
      await this._api('post', `/Items/${data.libraryId}/Refresh`, {
        Recursive: true,
        MetadataRefreshMode: 'Default',
        ImageRefreshMode: 'Default',
        ReplaceAllMetadata: false,
        ReplaceAllImages: false
      });
      return { success: true, result: `Library refresh started for library ${data.libraryId}.` };
    }

    await this._api('post', '/Library/Refresh');
    this.cache.del('libraries');
    return { success: true, result: 'Full Jellyfin library refresh started.' };
  }

  // ═══════════════════════════════════════
  //  ITEMS / MEDIA
  // ═══════════════════════════════════════

  async getItems(data) {
    const userId = await this._getAdminUserId();
    const params = {
      Recursive: true,
      StartIndex: data.startIndex || 0,
      Limit: data.limit || 25,
      SortBy: data.sortBy || 'SortName',
      SortOrder: data.sortOrder || 'Ascending',
      Fields: 'Overview,Genres,CommunityRating,OfficialRating,RunTimeTicks,Path'
    };

    if (data.type) params.IncludeItemTypes = data.type;
    if (data.genre) params.Genres = data.genre;
    if (data.year) params.Years = data.year;
    if (data.isFavorite) params.IsFavorite = true;
    if (data.parentId) params.ParentId = data.parentId;
    if (data.filter === 'played') params.IsPlayed = true;
    if (data.filter === 'unplayed') params.IsPlayed = false;

    const result = userId
      ? await this._api('get', `/Users/${userId}/Items`, null, params)
      : await this._api('get', '/Items', null, params);

    const items = result.Items || [];
    const total = result.TotalRecordCount || items.length;
    const typeLabel = data.type || 'items';

    return {
      success: true,
      total,
      items: items.map(i => this._formatItemSummary(i)),
      result: items.length === 0
        ? `No ${typeLabel} found in Jellyfin.`
        : `Jellyfin ${typeLabel} (${total} total, showing ${items.length}):\n${items.map(i =>
          `- ${i.Name}${i.ProductionYear ? ` (${i.ProductionYear})` : ''} [${i.Type}]${i.CommunityRating ? ` ★${i.CommunityRating.toFixed(1)}` : ''}`
        ).join('\n')}`
    };
  }

  async getItemDetails(data) {
    this.validateParams(data, { itemId: { required: true, type: 'string' } });

    const userId = await this._getAdminUserId();
    const item = userId
      ? await this._api('get', `/Users/${userId}/Items/${data.itemId}`)
      : await this._api('get', `/Items/${data.itemId}`);

    return {
      success: true,
      item: this._formatItemDetails(item),
      result: this._formatItemDetailsText(item)
    };
  }

  async getLatestMedia(data) {
    const userId = await this._getAdminUserId();
    if (!userId) return { success: false, error: 'Could not determine admin user for latest media query' };

    const params = {
      Limit: data.limit || 20,
      Fields: 'Overview,Genres,CommunityRating,OfficialRating'
    };
    if (data.type) params.IncludeItemTypes = data.type;
    if (data.parentId) params.ParentId = data.parentId;

    const items = await this._api('get', `/Users/${userId}/Items/Latest`, null, params);

    return {
      success: true,
      total: items.length,
      items: items.map(i => this._formatItemSummary(i)),
      result: items.length === 0
        ? 'No recently added media found.'
        : `Recently added to Jellyfin (${items.length}):\n${items.map(i =>
          `- ${i.Name}${i.ProductionYear ? ` (${i.ProductionYear})` : ''} [${i.Type}]`
        ).join('\n')}`
    };
  }

  async searchMedia(data) {
    if (!data.query && !data.title) {
      return { success: false, error: 'Provide a search query' };
    }

    const query = data.query || data.title;
    const userId = await this._getAdminUserId();
    const params = {
      SearchTerm: query,
      Limit: data.limit || 20,
      IncludeItemTypes: data.type || 'Movie,Series,Episode,Audio,MusicAlbum'
    };

    if (userId) params.UserId = userId;

    const result = await this._api('get', '/Search/Hints', null, params);
    const items = result.SearchHints || [];

    return {
      success: true,
      total: result.TotalRecordCount || items.length,
      results: items.map(i => ({
        id: i.ItemId || i.Id,
        name: i.Name,
        type: i.Type,
        year: i.ProductionYear,
        matchedTerm: i.MatchedTerm,
        series: i.Series,
        album: i.Album,
        artists: i.Artists
      })),
      result: items.length === 0
        ? `No results found for "${query}" on Jellyfin.`
        : `Jellyfin search results for "${query}" (${items.length}):\n${items.map((i, idx) =>
          `${idx + 1}. ${i.Name}${i.ProductionYear ? ` (${i.ProductionYear})` : ''} [${i.Type}]${i.Series ? ` — ${i.Series}` : ''}${i.Album ? ` — ${i.Album}` : ''}`
        ).join('\n')}`
    };
  }

  async deleteItem(data) {
    this.validateParams(data, { itemId: { required: true, type: 'string' } });
    await this._api('delete', `/Items/${data.itemId}`);
    return { success: true, result: `Item ${data.itemId} deleted from Jellyfin.` };
  }

  async refreshItem(data) {
    this.validateParams(data, { itemId: { required: true, type: 'string' } });
    await this._api('post', `/Items/${data.itemId}/Refresh`, {
      Recursive: true,
      MetadataRefreshMode: 'FullRefresh',
      ImageRefreshMode: 'FullRefresh',
      ReplaceAllMetadata: false,
      ReplaceAllImages: false
    });
    return { success: true, result: `Metadata refresh started for item ${data.itemId}.` };
  }

  // ═══════════════════════════════════════
  //  TV SHOWS
  // ═══════════════════════════════════════

  async getSeasons(data) {
    // If seriesId is missing but a name/title/query is provided, search for the series first
    if (!data.seriesId && (data.name || data.title || data.query || data.series)) {
      const searchTerm = data.name || data.title || data.query || data.series;
      const searchResult = await this._api('get', '/Search/Hints', null, {
        SearchTerm: searchTerm,
        IncludeItemTypes: 'Series',
        Limit: 5
      });

      const hints = searchResult.SearchHints || [];
      const match = hints.find(h => h.Type === 'Series');
      if (!match) {
        return { success: false, error: `No TV series found matching "${searchTerm}" on Jellyfin.` };
      }
      data.seriesId = match.ItemId || match.Id;
      data._resolvedSeriesName = match.Name;
    }

    this.validateParams(data, { seriesId: { required: true, type: 'string' } });

    const userId = await this._getAdminUserId();
    const params = { Fields: 'Overview' };
    if (userId) params.UserId = userId;

    const result = await this._api('get', `/Shows/${data.seriesId}/Seasons`, null, params);
    const seasons = result.Items || [];
    const seriesLabel = data._resolvedSeriesName || data.seriesId;

    return {
      success: true,
      total: seasons.length,
      seriesName: data._resolvedSeriesName || undefined,
      seasons: seasons.map(s => ({
        id: s.Id,
        name: s.Name,
        seasonNumber: s.IndexNumber,
        episodeCount: s.ChildCount,
        overview: s.Overview
      })),
      result: `${data._resolvedSeriesName ? `${data._resolvedSeriesName} — ` : ''}Seasons (${seasons.length}):\n${seasons.map(s =>
        `- ${s.Name} (${s.ChildCount || '?'} episodes)`
      ).join('\n')}`
    };
  }

  async getEpisodes(data) {
    // If seriesId is missing but a name/title/query is provided, search for the series first
    if (!data.seriesId && (data.name || data.title || data.query || data.series)) {
      const searchTerm = data.name || data.title || data.query || data.series;
      const searchResult = await this._api('get', '/Search/Hints', null, {
        SearchTerm: searchTerm,
        IncludeItemTypes: 'Series',
        Limit: 5
      });

      const hints = searchResult.SearchHints || [];
      const match = hints.find(h => h.Type === 'Series');
      if (!match) {
        return { success: false, error: `No TV series found matching "${searchTerm}" on Jellyfin.` };
      }
      data.seriesId = match.ItemId || match.Id;
    }

    this.validateParams(data, { seriesId: { required: true, type: 'string' } });

    const userId = await this._getAdminUserId();
    const params = {
      Fields: 'Overview',
      Limit: data.limit || 50
    };
    if (data.seasonId) params.SeasonId = data.seasonId;
    if (data.season) params.Season = data.season;
    if (userId) params.UserId = userId;

    const result = await this._api('get', `/Shows/${data.seriesId}/Episodes`, null, params);
    const episodes = result.Items || [];

    return {
      success: true,
      total: result.TotalRecordCount || episodes.length,
      episodes: episodes.map(e => ({
        id: e.Id,
        name: e.Name,
        seasonNumber: e.ParentIndexNumber,
        episodeNumber: e.IndexNumber,
        overview: e.Overview?.substring(0, 200),
        hasFile: e.LocationType !== 'Virtual'
      })),
      result: episodes.length === 0
        ? 'No episodes found.'
        : `Episodes (${episodes.length}):\n${episodes.map(e =>
          `- S${String(e.ParentIndexNumber || 0).padStart(2, '0')}E${String(e.IndexNumber || 0).padStart(2, '0')}: ${e.Name}`
        ).join('\n')}`
    };
  }

  async getNextUp(data) {
    const userId = await this._getAdminUserId();
    if (!userId) return { success: false, error: 'Could not determine user for next-up query' };

    const result = await this._api('get', '/Shows/NextUp', null, {
      UserId: userId,
      Limit: data.limit || 15,
      Fields: 'Overview'
    });

    const items = result.Items || [];
    return {
      success: true,
      total: items.length,
      episodes: items.map(e => ({
        id: e.Id,
        name: e.Name,
        seriesName: e.SeriesName,
        seasonNumber: e.ParentIndexNumber,
        episodeNumber: e.IndexNumber,
        overview: e.Overview?.substring(0, 200)
      })),
      result: items.length === 0
        ? 'No episodes in your next-up queue.'
        : `Next up (${items.length} episodes):\n${items.map(e =>
          `- ${e.SeriesName} — S${String(e.ParentIndexNumber || 0).padStart(2, '0')}E${String(e.IndexNumber || 0).padStart(2, '0')}: ${e.Name}`
        ).join('\n')}`
    };
  }

  // ═══════════════════════════════════════
  //  USERS
  // ═══════════════════════════════════════

  async getUsers() {
    const users = await this._cachedGet('users', '/Users', {}, 120);
    return {
      success: true,
      total: users.length,
      users: users.map(u => ({
        id: u.Id,
        name: u.Name,
        isAdministrator: u.Policy?.IsAdministrator || false,
        isDisabled: u.Policy?.IsDisabled || false,
        lastLoginDate: u.LastLoginDate,
        lastActivityDate: u.LastActivityDate
      })),
      result: `Jellyfin users (${users.length}):\n${users.map(u =>
        `- ${u.Name}${u.Policy?.IsAdministrator ? ' [Admin]' : ''}${u.Policy?.IsDisabled ? ' [Disabled]' : ''}${u.LastLoginDate ? ` — Last login: ${new Date(u.LastLoginDate).toLocaleDateString()}` : ''}`
      ).join('\n')}`
    };
  }

  async getUser(data) {
    this.validateParams(data, { userId: { required: true, type: 'string' } });
    const user = await this._api('get', `/Users/${data.userId}`);
    return {
      success: true,
      user: {
        id: user.Id,
        name: user.Name,
        isAdministrator: user.Policy?.IsAdministrator,
        isDisabled: user.Policy?.IsDisabled,
        lastLoginDate: user.LastLoginDate,
        lastActivityDate: user.LastActivityDate,
        hasPassword: user.HasPassword
      },
      result: [
        `User: ${user.Name}`,
        `Admin: ${user.Policy?.IsAdministrator ? 'Yes' : 'No'}`,
        `Disabled: ${user.Policy?.IsDisabled ? 'Yes' : 'No'}`,
        `Has Password: ${user.HasPassword ? 'Yes' : 'No'}`,
        user.LastLoginDate ? `Last Login: ${new Date(user.LastLoginDate).toLocaleString()}` : ''
      ].filter(Boolean).join('\n')
    };
  }

  async createUser(data) {
    this.validateParams(data, {
      name: { required: true, type: 'string' }
    });

    const user = await this._api('post', '/Users/New', {
      Name: data.name,
      Password: data.password || ''
    });

    this.cache.del('users');
    return {
      success: true,
      user: { id: user.Id, name: user.Name },
      result: `Created Jellyfin user "${user.Name}" (ID: ${user.Id}).`
    };
  }

  async deleteUser(data) {
    this.validateParams(data, { userId: { required: true, type: 'string' } });
    await this._api('delete', `/Users/${data.userId}`);
    this.cache.del('users');
    return { success: true, result: `User ${data.userId} deleted from Jellyfin.` };
  }

  async updateUserPassword(data) {
    this.validateParams(data, {
      userId: { required: true, type: 'string' },
      newPassword: { required: true, type: 'string' }
    });

    await this._api('post', `/Users/${data.userId}/Password`, {
      CurrentPw: data.currentPassword || '',
      NewPw: data.newPassword,
      ResetPassword: !data.currentPassword
    });

    return { success: true, result: `Password updated for user ${data.userId}.` };
  }

  // ═══════════════════════════════════════
  //  SESSIONS / PLAYBACK
  // ═══════════════════════════════════════

  async getSessions() {
    const sessions = await this._api('get', '/Sessions');
    const active = sessions.filter(s => s.NowPlayingItem);
    const idle = sessions.filter(s => !s.NowPlayingItem);

    return {
      success: true,
      total: sessions.length,
      activeSessions: active.length,
      sessions: sessions.map(s => ({
        id: s.Id,
        userName: s.UserName,
        client: s.Client,
        deviceName: s.DeviceName,
        nowPlaying: s.NowPlayingItem ? {
          name: s.NowPlayingItem.Name,
          type: s.NowPlayingItem.Type,
          seriesName: s.NowPlayingItem.SeriesName
        } : null,
        playState: s.PlayState ? {
          isPaused: s.PlayState.IsPaused,
          isMuted: s.PlayState.IsMuted,
          positionTicks: s.PlayState.PositionTicks
        } : null
      })),
      result: sessions.length === 0
        ? 'No active Jellyfin sessions.'
        : [
          `Jellyfin sessions (${sessions.length} total, ${active.length} playing):`,
          ...active.map(s => {
            const item = s.NowPlayingItem;
            const paused = s.PlayState?.IsPaused ? ' [Paused]' : '';
            return `▶ ${s.UserName} on ${s.DeviceName} — ${item.SeriesName ? `${item.SeriesName}: ` : ''}${item.Name}${paused}`;
          }),
          ...idle.map(s => `○ ${s.UserName || 'Unknown'} on ${s.DeviceName} (${s.Client}) — Idle`)
        ].join('\n')
    };
  }

  async sendPlayCommand(data) {
    this.validateParams(data, {
      sessionId: { required: true, type: 'string' },
      command: { required: true, type: 'string' }
    });

    const validCommands = ['Play', 'Pause', 'Unpause', 'Stop', 'NextTrack', 'PreviousTrack', 'Seek', 'PlayPause'];
    const command = data.command.charAt(0).toUpperCase() + data.command.slice(1);

    if (!validCommands.includes(command)) {
      return { success: false, error: `Invalid command. Valid commands: ${validCommands.join(', ')}` };
    }

    await this._api('post', `/Sessions/${data.sessionId}/Playing/${command}`, {
      ...(data.seekPositionTicks ? { SeekPositionTicks: data.seekPositionTicks } : {})
    });

    return { success: true, result: `Sent "${command}" command to session ${data.sessionId}.` };
  }

  async sendMessage(data) {
    this.validateParams(data, {
      sessionId: { required: true, type: 'string' },
      text: { required: true, type: 'string' }
    });

    await this._api('post', `/Sessions/${data.sessionId}/Message`, {
      Text: data.text,
      Header: data.header || 'LANAgent',
      TimeoutMs: data.timeoutMs || 5000
    });

    return { success: true, result: `Message sent to session ${data.sessionId}.` };
  }

  // ═══════════════════════════════════════
  //  PLAYLISTS
  // ═══════════════════════════════════════

  async getPlaylists() {
    const userId = await this._getAdminUserId();
    const params = {
      IncludeItemTypes: 'Playlist',
      Recursive: true,
      Fields: 'ChildCount'
    };

    const result = userId
      ? await this._api('get', `/Users/${userId}/Items`, null, params)
      : await this._api('get', '/Items', null, params);

    const playlists = result.Items || [];
    return {
      success: true,
      total: playlists.length,
      playlists: playlists.map(p => ({
        id: p.Id,
        name: p.Name,
        itemCount: p.ChildCount,
        mediaType: p.MediaType
      })),
      result: playlists.length === 0
        ? 'No playlists found in Jellyfin.'
        : `Jellyfin playlists (${playlists.length}):\n${playlists.map(p =>
          `- ${p.Name} (${p.ChildCount || 0} items) [${p.MediaType || 'mixed'}]`
        ).join('\n')}`
    };
  }

  async createPlaylist(data) {
    this.validateParams(data, { name: { required: true, type: 'string' } });

    const userId = await this._getAdminUserId();
    const playlist = await this._api('post', '/Playlists', {
      Name: data.name,
      Ids: data.ids || [],
      UserId: userId,
      MediaType: data.mediaType || 'Video'
    });

    return {
      success: true,
      playlist: { id: playlist.Id, name: data.name },
      result: `Playlist "${data.name}" created (ID: ${playlist.Id}).`
    };
  }

  async addToPlaylist(data) {
    this.validateParams(data, {
      playlistId: { required: true, type: 'string' },
      ids: { required: true, type: 'array' }
    });

    const userId = await this._getAdminUserId();
    await this._api('post', `/Playlists/${data.playlistId}/Items`, null, {
      Ids: data.ids.join(','),
      UserId: userId
    });

    return { success: true, result: `Added ${data.ids.length} item(s) to playlist.` };
  }

  async removeFromPlaylist(data) {
    this.validateParams(data, {
      playlistId: { required: true, type: 'string' },
      entryIds: { required: true, type: 'array' }
    });

    await this._api('delete', `/Playlists/${data.playlistId}/Items`, null, {
      EntryIds: data.entryIds.join(',')
    });

    return { success: true, result: `Removed ${data.entryIds.length} item(s) from playlist.` };
  }

  // ═══════════════════════════════════════
  //  PLUGINS / PACKAGES
  // ═══════════════════════════════════════

  async getInstalledPlugins() {
    const plugins = await this._cachedGet('installedPlugins', '/Plugins', {}, 300);
    return {
      success: true,
      total: plugins.length,
      plugins: plugins.map(p => ({
        id: p.Id,
        name: p.Name,
        version: p.Version,
        description: p.Description,
        status: p.Status,
        hasImage: p.HasImage
      })),
      result: plugins.length === 0
        ? 'No plugins installed on Jellyfin.'
        : `Installed Jellyfin plugins (${plugins.length}):\n${plugins.map(p =>
          `- ${p.Name} v${p.Version} [${p.Status}]`
        ).join('\n')}`
    };
  }

  async getAvailablePackages() {
    const packages = await this._cachedGet('availablePackages', '/Packages', {}, 600);
    return {
      success: true,
      total: packages.length,
      packages: packages.slice(0, 50).map(p => ({
        name: p.name,
        description: p.description?.substring(0, 200),
        category: p.category,
        owner: p.owner,
        versions: p.versions?.length || 0
      })),
      result: `Available Jellyfin packages (${packages.length}):\n${packages.slice(0, 30).map(p =>
        `- ${p.name}${p.category ? ` [${p.category}]` : ''} — ${p.description?.substring(0, 80) || 'No description'}`
      ).join('\n')}${packages.length > 30 ? `\n... and ${packages.length - 30} more` : ''}`
    };
  }

  // ═══════════════════════════════════════
  //  FORMATTING HELPERS
  // ═══════════════════════════════════════

  _formatItemSummary(item) {
    return {
      id: item.Id,
      name: item.Name,
      type: item.Type,
      year: item.ProductionYear,
      rating: item.CommunityRating,
      officialRating: item.OfficialRating,
      genres: item.Genres,
      overview: item.Overview?.substring(0, 200),
      seriesName: item.SeriesName,
      seasonNumber: item.ParentIndexNumber,
      episodeNumber: item.IndexNumber
    };
  }

  _formatItemDetails(item) {
    return {
      id: item.Id,
      name: item.Name,
      type: item.Type,
      year: item.ProductionYear,
      rating: item.CommunityRating,
      officialRating: item.OfficialRating,
      genres: item.Genres,
      overview: item.Overview,
      seriesName: item.SeriesName,
      studios: item.Studios?.map(s => s.Name),
      people: item.People?.slice(0, 10).map(p => ({ name: p.Name, role: p.Role, type: p.Type })),
      runTimeTicks: item.RunTimeTicks,
      path: item.Path,
      mediaStreams: item.MediaStreams?.map(s => ({
        type: s.Type,
        codec: s.Codec,
        language: s.Language,
        displayTitle: s.DisplayTitle
      }))
    };
  }

  _formatItemDetailsText(item) {
    const runtime = item.RunTimeTicks ? `${Math.round(item.RunTimeTicks / 600000000)} min` : '';
    return [
      `${item.Name}${item.ProductionYear ? ` (${item.ProductionYear})` : ''} [${item.Type}]`,
      item.SeriesName ? `Series: ${item.SeriesName}` : '',
      item.Overview ? item.Overview.substring(0, 300) : '',
      item.CommunityRating ? `Rating: ★${item.CommunityRating.toFixed(1)}` : '',
      item.OfficialRating ? `Rated: ${item.OfficialRating}` : '',
      item.Genres?.length ? `Genres: ${item.Genres.join(', ')}` : '',
      runtime ? `Runtime: ${runtime}` : '',
      item.Studios?.length ? `Studios: ${item.Studios.map(s => s.Name).join(', ')}` : '',
      item.People?.length ? `Cast: ${item.People.slice(0, 5).map(p => p.Name).join(', ')}` : '',
      item.Path ? `Path: ${item.Path}` : ''
    ].filter(Boolean).join('\n');
  }
}
