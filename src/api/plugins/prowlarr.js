import { ArrBasePlugin } from './arr-base-helper.js';

export default class ProwlarrPlugin extends ArrBasePlugin {
  constructor(agent) {
    super(agent, {
      name: 'prowlarr',
      version: '1.0.0',
      description: 'Manage indexers and perform cross-indexer searches with Prowlarr — the indexer manager for the *arr ecosystem',
      apiVersion: 'v1',
      envPrefix: 'PROWLARR',
      commands: [
        {
          command: 'get_indexers',
          description: 'List all configured indexers in Prowlarr with their status',
          usage: 'get_indexers()',
          examples: [
            'show me all prowlarr indexers',
            'list my indexers on prowlarr',
            'what indexers do I have in prowlarr',
            'prowlarr indexer list',
            'which indexers are configured',
            'how many indexers are in prowlarr'
          ]
        },
        {
          command: 'test_indexer',
          description: 'Test connectivity and functionality of a specific indexer or all indexers',
          usage: 'test_indexer({ name: "1337x" })',
          examples: [
            'test all prowlarr indexers',
            'test 1337x indexer on prowlarr',
            'check if my indexers are working',
            'prowlarr test indexers',
            'which indexers are down',
            'are my prowlarr indexers online'
          ]
        },
        {
          command: 'search',
          description: 'Search across all enabled indexers for content using Prowlarr',
          usage: 'search({ query: "ubuntu iso" })',
          examples: [
            'search prowlarr for ubuntu iso',
            'prowlarr search for latest linux distro',
            'search all indexers for Blender',
            'find something on prowlarr',
            'prowlarr look up LibreOffice',
            'cross-search prowlarr for open source software'
          ]
        },
        {
          command: 'get_applications',
          description: 'List all connected *arr applications synced with Prowlarr',
          usage: 'get_applications()',
          examples: [
            'show prowlarr connected apps',
            'what apps are connected to prowlarr',
            'prowlarr application list',
            'which arr apps does prowlarr manage',
            'list prowlarr synced applications'
          ]
        },
        {
          command: 'get_stats',
          description: 'Show indexer performance statistics from Prowlarr',
          usage: 'get_stats()',
          examples: [
            'show prowlarr stats',
            'prowlarr indexer statistics',
            'how are my indexers performing',
            'prowlarr performance stats',
            'indexer usage statistics',
            'prowlarr analytics'
          ]
        },
        {
          command: 'get_health',
          description: 'Check Prowlarr system health for issues or warnings',
          usage: 'get_health()',
          examples: [
            'is prowlarr healthy',
            'check prowlarr health',
            'any prowlarr issues',
            'prowlarr system status',
            'is prowlarr working properly',
            'prowlarr health check'
          ]
        },
        {
          command: 'get_status',
          description: 'Get Prowlarr server version, uptime, and system information',
          usage: 'get_status()',
          examples: [
            'prowlarr version',
            'what version of prowlarr is running',
            'prowlarr system info',
            'prowlarr server status'
          ]
        },
        {
          command: 'sync',
          description: 'Trigger a sync of indexers to all connected *arr applications',
          usage: 'sync()',
          examples: [
            'sync prowlarr indexers',
            'prowlarr sync to all apps',
            'push prowlarr indexers to radarr and sonarr',
            'sync prowlarr with my arr apps',
            'trigger prowlarr app sync'
          ]
        }
      ],
      intents: {
        listIndexers: {
          name: 'List Prowlarr Indexers',
          description: 'Show all configured indexers in Prowlarr',
          action: 'get_indexers',
          examples: ['show indexers', 'my indexers', 'list all indexers', 'what indexers do I have']
        },
        testIndexers: {
          name: 'Test Prowlarr Indexers',
          description: 'Test indexer connectivity',
          action: 'test_indexer',
          examples: ['test indexers', 'check indexers', 'are indexers working', 'indexer status']
        },
        searchIndexers: {
          name: 'Prowlarr Search',
          description: 'Search across all indexers',
          action: 'search',
          examples: ['search prowlarr', 'find on indexers', 'cross-search', 'search all indexers']
        },
        connectedApps: {
          name: 'Prowlarr Applications',
          description: 'View connected *arr applications',
          action: 'get_applications',
          examples: ['prowlarr apps', 'connected applications', 'synced apps', 'arr applications']
        },
        indexerStats: {
          name: 'Prowlarr Statistics',
          description: 'View indexer performance statistics',
          action: 'get_stats',
          examples: ['prowlarr stats', 'indexer performance', 'indexer analytics', 'search statistics']
        },
        prowlarrHealth: {
          name: 'Prowlarr Health',
          description: 'Check Prowlarr health status',
          action: 'get_health',
          examples: ['prowlarr health', 'is prowlarr ok', 'prowlarr working', 'check prowlarr']
        },
        syncApps: {
          name: 'Sync Prowlarr',
          description: 'Sync indexers to connected apps',
          action: 'sync',
          examples: ['sync prowlarr', 'push indexers', 'sync to arr apps', 'update arr indexers']
        }
      }
    });
  }

  async execute(params) {
    return this._executeAction(params, {
      get_indexers: this.getIndexers,
      test_indexer: this.testIndexer,
      search: this.searchIndexers,
      get_applications: this.getApplications,
      get_stats: this.getStats,
      get_health: this.getHealth,
      get_status: this.getSystemStatus,
      sync: this.syncApps
    });
  }

  // ─── Indexer Actions ───

  async getIndexers(data) {
    const indexers = await this._cachedGet('indexers', '/indexer', null, 60);
    if (!indexers) return { success: false, error: 'Could not fetch indexers from Prowlarr' };

    let filtered = Array.isArray(indexers) ? indexers : [];

    if (data.filter === 'enabled') {
      filtered = filtered.filter(i => i.enable);
    } else if (data.filter === 'disabled') {
      filtered = filtered.filter(i => !i.enable);
    }

    return {
      success: true,
      total: filtered.length,
      indexers: filtered.map(i => ({
        id: i.id,
        name: i.name,
        protocol: i.protocol,
        privacy: i.privacy,
        enabled: i.enable,
        priority: i.priority,
        categories: i.capabilities?.categories?.map(c => c.name) || [],
        supportsSearch: i.supportsSearch,
        supportsRss: i.supportsRss
      })),
      result: `Prowlarr: ${filtered.length} indexers${data.filter ? ` (${data.filter})` : ''}:\n${
        filtered.map(i => `- ${i.name} [${i.protocol}] ${i.enable ? 'enabled' : 'DISABLED'} (priority: ${i.priority})`).join('\n')
      }`
    };
  }

  async testIndexer(data) {
    if (data.id || data.name) {
      // Test a specific indexer
      let indexerId = data.id;

      if (!indexerId && data.name) {
        const indexers = await this._cachedGet('indexers', '/indexer', null, 60);
        const query = data.name.toLowerCase();
        const match = (indexers || []).find(i => i.name.toLowerCase().includes(query));
        if (!match) return { success: false, error: `No indexer matching "${data.name}" found` };
        indexerId = match.id;
      }

      try {
        await this._apiPost(`/indexer/test`, { id: indexerId });
        return { success: true, result: `Indexer test passed.` };
      } catch (error) {
        return { success: false, error: `Indexer test failed: ${error.message}` };
      }
    }

    // Test all indexers
    try {
      const results = await this._apiPost('/indexer/testall');
      const passed = (results || []).filter(r => r.isValid);
      const failed = (results || []).filter(r => !r.isValid);

      return {
        success: true,
        total: (results || []).length,
        passed: passed.length,
        failed: failed.length,
        results: (results || []).map(r => ({
          id: r.id,
          isValid: r.isValid,
          validationFailures: r.validationFailures
        })),
        result: `Indexer test: ${passed.length} passed, ${failed.length} failed out of ${(results || []).length} total.${
          failed.length > 0 ? `\nFailed:\n${failed.map(r => `- ID ${r.id}: ${r.validationFailures?.map(f => f.errorMessage).join(', ') || 'unknown error'}`).join('\n')}` : ''
        }`
      };
    } catch (error) {
      return { success: false, error: `Test all failed: ${error.message}` };
    }
  }

  async searchIndexers(data) {
    const query = data.query || data.term;
    if (!query) return { success: false, error: 'Provide a search query' };

    const params = { query, type: 'search' };

    if (data.categories) params.categories = Array.isArray(data.categories) ? data.categories : [data.categories];
    if (data.indexerIds) params.indexerIds = Array.isArray(data.indexerIds) ? data.indexerIds : [data.indexerIds];

    const results = await this._apiRequest('get', '/search', null, params);
    if (!results || results.length === 0) {
      return { success: false, error: `No results found for "${query}"` };
    }

    return {
      success: true,
      total: results.length,
      results: results.slice(0, 25).map(r => ({
        title: r.title,
        indexer: r.indexer,
        size: r.size,
        sizeFormatted: r.size ? `${(r.size / 1073741824).toFixed(2)} GB` : 'unknown',
        seeders: r.seeders,
        leechers: r.leechers,
        publishDate: r.publishDate,
        categories: r.categories?.map(c => c.name),
        downloadUrl: r.downloadUrl,
        infoUrl: r.infoUrl
      })),
      result: `Found ${results.length} result(s) for "${query}":\n${
        results.slice(0, 15).map((r, i) => {
          const size = r.size ? `${(r.size / 1073741824).toFixed(1)}GB` : '?';
          const seeds = r.seeders != null ? `S:${r.seeders}` : '';
          return `${i + 1}. ${r.title} [${r.indexer}] ${size} ${seeds}`;
        }).join('\n')
      }${results.length > 15 ? `\n... and ${results.length - 15} more` : ''}`
    };
  }

  async getApplications() {
    const apps = await this._cachedGet('applications', '/applications', null, 300);
    if (!apps) return { success: false, error: 'Could not fetch applications from Prowlarr' };

    const list = Array.isArray(apps) ? apps : [];
    return {
      success: true,
      total: list.length,
      applications: list.map(a => ({
        id: a.id,
        name: a.name,
        implementation: a.implementation,
        syncLevel: a.syncLevel,
        tags: a.tags
      })),
      result: list.length === 0
        ? 'No applications connected to Prowlarr.'
        : `Prowlarr connected apps (${list.length}):\n${list.map(a => `- ${a.name} (${a.implementation}) — sync: ${a.syncLevel}`).join('\n')}`
    };
  }

  async getStats() {
    const stats = await this._cachedGet('indexerstats', '/indexerstats', null, 120);
    if (!stats) return { success: false, error: 'Could not fetch stats from Prowlarr' };

    const indexers = stats.indexers || [];
    return {
      success: true,
      indexers: indexers.map(i => ({
        id: i.indexerId,
        name: i.indexerName,
        queries: i.numberOfQueries,
        grabs: i.numberOfGrabs,
        rssQueries: i.numberOfRssQueries,
        authQueries: i.numberOfAuthQueries,
        failedQueries: i.numberOfFailedQueries,
        failedGrabs: i.numberOfFailedGrabs,
        averageResponseTime: i.averageResponseTime
      })),
      result: indexers.length === 0
        ? 'No indexer statistics available.'
        : `Prowlarr indexer stats:\n${indexers.map(i =>
          `- ${i.indexerName}: ${i.numberOfQueries} queries, ${i.numberOfGrabs} grabs, ${i.numberOfFailedQueries} failed (avg ${i.averageResponseTime || '?'}ms)`
        ).join('\n')}`
    };
  }

  async syncApps() {
    return this.executeArrCommand('AppIndexerSync');
  }
}
