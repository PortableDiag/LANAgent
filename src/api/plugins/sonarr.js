import { ArrBasePlugin } from './arr-base-helper.js';

export default class SonarrPlugin extends ArrBasePlugin {
  constructor(agent) {
    super(agent, {
      name: 'sonarr',
      version: '1.0.0',
      description: 'Manage TV series with Sonarr — search, add, remove, track episodes and upcoming shows',
      apiVersion: 'v3',
      envPrefix: 'SONARR',
      commands: [
        {
          command: 'get_series',
          description: 'List all TV series currently in the Sonarr library',
          usage: 'get_series({ filter: "monitored" })',
          examples: [
            'show me all my TV shows in sonarr',
            'list my sonarr series library',
            'what shows do I have in sonarr',
            'show monitored series',
            'sonarr series list',
            'how many shows are in sonarr'
          ]
        },
        {
          command: 'get_series_details',
          description: 'Get detailed information about a specific TV series in Sonarr',
          usage: 'get_series_details({ title: "Breaking Bad" })',
          examples: [
            'show me details for Breaking Bad in sonarr',
            'get info about The Office from sonarr',
            'sonarr series info for Game of Thrones',
            'look up Stranger Things in my sonarr library'
          ]
        },
        {
          command: 'search_series',
          description: 'Search for a TV series to add to Sonarr (looks up on TVDB/online)',
          usage: 'search_series({ query: "Fallout" })',
          examples: [
            'search sonarr for Fallout',
            'find The Last of Us on sonarr',
            'look up House of the Dragon in sonarr',
            'search for the new Shogun series',
            'sonarr search Penguin',
            'can you find Reacher on sonarr'
          ]
        },
        {
          command: 'add_series',
          description: 'Add a new TV series to Sonarr for monitoring and downloading',
          usage: 'add_series({ title: "Fallout", tvdbId: 403172 })',
          examples: [
            'add Fallout to sonarr',
            'download The Last of Us with sonarr',
            'add that show to sonarr',
            'put Shogun in sonarr',
            'add the new Penguin series to sonarr',
            'sonarr grab Reacher'
          ]
        },
        {
          command: 'delete_series',
          description: 'Remove a TV series from the Sonarr library, optionally deleting files',
          usage: 'delete_series({ title: "Bad Show", deleteFiles: true })',
          examples: [
            'remove Bad Show from sonarr',
            'delete that series from sonarr',
            'sonarr remove The Walking Dead and delete files',
            'take that show off sonarr'
          ]
        },
        {
          command: 'get_episodes',
          description: 'Get episode list for a specific series in Sonarr',
          usage: 'get_episodes({ title: "Breaking Bad", season: 5 })',
          examples: [
            'show episodes of Breaking Bad in sonarr',
            'list episodes for Game of Thrones season 8',
            'what episodes are missing for Stranger Things',
            'sonarr episodes for The Office'
          ]
        },
        {
          command: 'get_calendar',
          description: 'Show upcoming and recently aired TV episodes tracked by Sonarr',
          usage: 'get_calendar()',
          examples: [
            'what episodes are airing this week',
            'sonarr upcoming episodes',
            'upcoming TV on sonarr',
            'what shows have new episodes coming',
            'show me the sonarr calendar',
            'any new episodes airing soon',
            'what airs tonight'
          ]
        },
        {
          command: 'get_queue',
          description: 'Show the current Sonarr download queue with progress',
          usage: 'get_queue()',
          examples: [
            'show sonarr download queue',
            'what is sonarr downloading',
            'sonarr queue status',
            'any episodes downloading right now',
            'check sonarr downloads',
            'sonarr download progress'
          ]
        },
        {
          command: 'get_wanted',
          description: 'Show missing or cutoff-unmet episodes in Sonarr',
          usage: 'get_wanted()',
          examples: [
            'what episodes are missing in sonarr',
            'show sonarr wanted list',
            'missing episodes in sonarr',
            'sonarr wanted episodes',
            'what does sonarr still need to download'
          ]
        },
        {
          command: 'get_history',
          description: 'Show recent Sonarr activity and download history',
          usage: 'get_history({ page: 1 })',
          examples: [
            'show sonarr history',
            'recent sonarr activity',
            'what has sonarr downloaded recently',
            'sonarr download log'
          ]
        },
        {
          command: 'get_health',
          description: 'Check Sonarr system health for issues or warnings',
          usage: 'get_health()',
          examples: [
            'is sonarr healthy',
            'check sonarr health',
            'any sonarr issues',
            'sonarr system status',
            'is sonarr working properly',
            'sonarr health check'
          ]
        },
        {
          command: 'get_status',
          description: 'Get Sonarr server version, uptime, and system information',
          usage: 'get_status()',
          examples: [
            'sonarr version',
            'what version of sonarr is running',
            'sonarr system info',
            'sonarr server status'
          ]
        },
        {
          command: 'refresh',
          description: 'Trigger a metadata refresh for all series or a specific series in Sonarr',
          usage: 'refresh({ title: "Breaking Bad" })',
          examples: [
            'refresh sonarr library',
            'sonarr refresh all series',
            'update sonarr metadata',
            'refresh Breaking Bad in sonarr'
          ]
        },
        {
          command: 'search_downloads',
          description: 'Trigger a download search in Sonarr for missing or wanted episodes',
          usage: 'search_downloads({ title: "Breaking Bad" })',
          examples: [
            'search for missing sonarr episodes',
            'sonarr search for downloads',
            'find downloads for Breaking Bad on sonarr',
            'sonarr grab missing episodes'
          ]
        }
      ],
      intents: {
        listSeries: {
          name: 'List Sonarr Series',
          description: 'Show the TV series library in Sonarr',
          action: 'get_series',
          examples: ['show sonarr shows', 'my TV collection', 'list all series', 'what shows do I have']
        },
        searchSeries: {
          name: 'Search Series on Sonarr',
          description: 'Search for a TV series to add to Sonarr',
          action: 'search_series',
          examples: ['search for a show', 'find series on sonarr', 'look up a TV show', 'search sonarr']
        },
        addSeries: {
          name: 'Add Series to Sonarr',
          description: 'Add a new TV series to Sonarr for downloading',
          action: 'add_series',
          examples: ['add show to sonarr', 'download a series', 'grab a show', 'put series in sonarr']
        },
        episodeCalendar: {
          name: 'Sonarr Calendar',
          description: 'View upcoming TV episodes',
          action: 'get_calendar',
          examples: ['upcoming episodes', 'TV calendar', 'new episodes', 'what airs this week']
        },
        episodeQueue: {
          name: 'Sonarr Queue',
          description: 'Check the download queue',
          action: 'get_queue',
          examples: ['sonarr downloads', 'episode queue', 'what is downloading', 'download status']
        },
        missingEpisodes: {
          name: 'Missing Episodes',
          description: 'Find missing episodes in Sonarr',
          action: 'get_wanted',
          examples: ['missing episodes', 'wanted episodes', 'what episodes am I missing', 'sonarr wanted']
        },
        seriesHealth: {
          name: 'Sonarr Health',
          description: 'Check Sonarr health status',
          action: 'get_health',
          examples: ['sonarr health', 'is sonarr ok', 'sonarr working', 'check sonarr']
        }
      }
    });
  }

  async execute(params) {
    return this._executeAction(params, {
      get_series: this.getSeries,
      get_series_details: this.getSeriesDetails,
      search_series: this.searchSeries,
      add_series: this.addSeries,
      delete_series: this.deleteSeries,
      get_episodes: this.getEpisodes,
      get_calendar: this.getEpisodeCalendar,
      get_queue: this.getQueue,
      get_wanted: this.getWanted,
      get_history: this.getHistory,
      get_health: this.getHealth,
      get_status: this.getSystemStatus,
      refresh: this.refreshSeries,
      search_downloads: this.searchDownloads
    });
  }

  // ─── Series Actions ───

  async getSeries(data) {
    const series = await this._cachedGet('series', '/series');
    if (!series) return { success: false, error: 'Could not fetch series from Sonarr' };

    let filtered = Array.isArray(series) ? series : [];

    if (data.filter === 'monitored') {
      filtered = filtered.filter(s => s.monitored);
    } else if (data.filter === 'unmonitored') {
      filtered = filtered.filter(s => !s.monitored);
    } else if (data.filter === 'continuing') {
      filtered = filtered.filter(s => s.status === 'continuing');
    } else if (data.filter === 'ended') {
      filtered = filtered.filter(s => s.status === 'ended');
    }

    return {
      success: true,
      total: filtered.length,
      series: filtered.map(s => ({
        id: s.id,
        title: s.title,
        year: s.year,
        seasons: s.statistics?.seasonCount ?? s.seasonCount,
        episodeCount: s.statistics?.episodeCount ?? s.episodeCount,
        episodeFileCount: s.statistics?.episodeFileCount ?? s.episodeFileCount,
        monitored: s.monitored,
        status: s.status,
        network: s.network,
        tvdbId: s.tvdbId
      })),
      result: `Sonarr library: ${filtered.length} series${data.filter ? ` (${data.filter})` : ''}:\n${
        filtered.slice(0, 25).map(s => {
          const seasons = s.statistics?.seasonCount ?? s.seasonCount ?? '?';
          const fileCount = s.statistics?.episodeFileCount ?? s.episodeFileCount ?? '?';
          const epCount = s.statistics?.episodeCount ?? s.episodeCount ?? '?';
          return `- ${s.title} (${s.year}) — ${seasons}S, ${fileCount}/${epCount} eps [${s.status}]`;
        }).join('\n')
      }${filtered.length > 25 ? `\n... and ${filtered.length - 25} more` : ''}`
    };
  }

  async getSeriesDetails(data) {
    if (data.id) {
      const series = await this._cachedGet(`series_${data.id}`, `/series/${data.id}`);
      if (!series) return { success: false, error: `Series ID ${data.id} not found` };
      return { success: true, series, result: this._formatSeries(series) };
    }

    if (data.title || data.name) {
      const allSeries = await this._cachedGet('series', '/series');
      const query = (data.title || data.name).toLowerCase();
      const match = (allSeries || []).find(s =>
        s.title.toLowerCase() === query ||
        s.title.toLowerCase().includes(query) ||
        (s.alternateTitles && s.alternateTitles.some(t => t.title.toLowerCase().includes(query)))
      );
      if (!match) return { success: false, error: `No series matching "${data.title || data.name}" found in library` };
      return { success: true, series: match, result: this._formatSeries(match) };
    }

    return { success: false, error: 'Provide a series title or ID' };
  }

  async searchSeries(data) {
    const term = data.query || data.title || data.name;
    if (!term) return { success: false, error: 'Provide a search query (series title)' };

    const results = await this._apiRequest('get', '/series/lookup', null, { term });
    if (!results || results.length === 0) {
      return { success: false, error: `No results found for "${term}"` };
    }

    return {
      success: true,
      results: results.slice(0, 10).map(s => ({
        title: s.title,
        year: s.year,
        tvdbId: s.tvdbId,
        overview: s.overview?.substring(0, 200),
        seasons: s.seasonCount,
        network: s.network,
        status: s.status
      })),
      result: `Found ${results.length} result(s) for "${term}":\n${
        results.slice(0, 10).map((s, i) => `${i + 1}. ${s.title} (${s.year}) — ${s.network || 'N/A'} [tvdb:${s.tvdbId}]`).join('\n')
      }`
    };
  }

  async addSeries(data) {
    let seriesData = null;

    if (data.tvdbId) {
      const results = await this._apiRequest('get', '/series/lookup', null, { term: `tvdb:${data.tvdbId}` });
      seriesData = results?.[0];
    } else if (data.title || data.name || data.query) {
      const term = data.title || data.name || data.query;
      const results = await this._apiRequest('get', '/series/lookup', null, { term });
      if (!results || results.length === 0) {
        return { success: false, error: `No series found matching "${term}"` };
      }
      seriesData = results[0];
    } else {
      return { success: false, error: 'Provide a series title or tvdbId to add' };
    }

    if (!seriesData) return { success: false, error: 'Could not find series to add' };

    // Check if already in library
    const existing = await this._cachedGet('series', '/series');
    if (existing?.find(s => s.tvdbId === seriesData.tvdbId)) {
      return { success: false, error: `"${seriesData.title}" is already in your Sonarr library` };
    }

    const rootFolders = await this._apiGet('/rootfolder');
    const profiles = await this._apiGet('/qualityprofile');

    if (!rootFolders?.length) return { success: false, error: 'No root folders configured in Sonarr' };
    if (!profiles?.length) return { success: false, error: 'No quality profiles configured in Sonarr' };

    const addPayload = {
      title: seriesData.title,
      tvdbId: seriesData.tvdbId,
      year: seriesData.year,
      qualityProfileId: data.qualityProfileId || profiles[0].id,
      rootFolderPath: data.rootFolder || rootFolders[0].path,
      monitored: data.monitored !== false,
      seasonFolder: true,
      seriesType: data.seriesType || 'standard',
      addOptions: {
        searchForMissingEpisodes: data.search !== false,
        searchForCutoffUnmetEpisodes: false
      }
    };

    const result = await this._apiPost('/series', addPayload);
    this.cache.del('series');

    return {
      success: true,
      series: { id: result.id, title: result.title, year: result.year, tvdbId: result.tvdbId },
      result: `Added "${result.title} (${result.year})" to Sonarr. ${data.search !== false ? 'Search for missing episodes triggered.' : ''}`
    };
  }

  async deleteSeries(data) {
    let seriesId = data.id;

    if (!seriesId && (data.title || data.name)) {
      const allSeries = await this._cachedGet('series', '/series');
      const query = (data.title || data.name).toLowerCase();
      const match = (allSeries || []).find(s => s.title.toLowerCase().includes(query));
      if (!match) return { success: false, error: `No series matching "${data.title || data.name}" found in library` };
      seriesId = match.id;
    }

    if (!seriesId) return { success: false, error: 'Provide a series title or ID to delete' };

    await this._apiDelete(`/series/${seriesId}`, {
      deleteFiles: data.deleteFiles === true
    });

    this.cache.del('series');
    return {
      success: true,
      result: `Series removed from Sonarr.${data.deleteFiles ? ' Files deleted.' : ''}`
    };
  }

  async getEpisodes(data) {
    let seriesId = data.seriesId || data.id;

    if (!seriesId && data.title) {
      const allSeries = await this._cachedGet('series', '/series');
      const query = data.title.toLowerCase();
      const match = (allSeries || []).find(s => s.title.toLowerCase().includes(query));
      if (!match) return { success: false, error: `No series matching "${data.title}" found` };
      seriesId = match.id;
    }

    if (!seriesId) return { success: false, error: 'Provide a series title or ID' };

    const episodes = await this._cachedGet(`episodes_${seriesId}`, '/episode', { seriesId }, 60);
    if (!episodes) return { success: false, error: 'Could not fetch episodes' };

    let filtered = Array.isArray(episodes) ? episodes : [];
    if (data.season) {
      filtered = filtered.filter(e => e.seasonNumber === parseInt(data.season));
    }

    return {
      success: true,
      total: filtered.length,
      episodes: filtered.map(e => ({
        id: e.id,
        season: e.seasonNumber,
        episode: e.episodeNumber,
        title: e.title,
        airDate: e.airDate,
        hasFile: e.hasFile,
        monitored: e.monitored
      })),
      result: `${filtered.length} episodes${data.season ? ` (S${String(data.season).padStart(2, '0')})` : ''}:\n${
        filtered.slice(0, 30).map(e => `- S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')} ${e.title} ${e.hasFile ? '[downloaded]' : '[missing]'}`).join('\n')
      }${filtered.length > 30 ? `\n... and ${filtered.length - 30} more` : ''}`
    };
  }

  async getEpisodeCalendar(data) {
    // Override base getCalendar to include series data in each episode
    const now = new Date();
    const start = data.start || new Date(now.getTime() - 7 * 86400000).toISOString();
    const end = data.end || new Date(now.getTime() + 30 * 86400000).toISOString();

    const calData = await this._cachedGet(`calendar_series_${start}_${end}`, '/calendar', {
      start, end, includeSeries: true
    }, 120);

    const items = Array.isArray(calData) ? calData : [];
    return {
      success: true,
      total: items.length,
      episodes: items.map(e => ({
        seriesTitle: e.series?.title,
        season: e.seasonNumber,
        episode: e.episodeNumber,
        title: e.title,
        airDate: e.airDateUtc || e.airDate,
        hasFile: e.hasFile,
        monitored: e.monitored
      })),
      result: items.length === 0
        ? 'No upcoming episodes on the Sonarr calendar.'
        : `Sonarr calendar (${items.length} episodes):\n${items.map(e => {
          const date = e.airDateUtc ? new Date(e.airDateUtc).toLocaleDateString() : e.airDate || 'TBD';
          return `- ${e.series?.title} S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')} "${e.title}" — ${date} ${e.hasFile ? '[downloaded]' : ''}`;
        }).join('\n')}`
    };
  }

  async getWanted(data) {
    const page = data.page || 1;
    const pageSize = data.pageSize || 20;

    const result = await this._cachedGet(`wanted_${page}`, '/wanted/missing', {
      page, pageSize, sortKey: 'airDateUtc', sortDirection: 'descending'
    }, 60);

    if (!result) return { success: false, error: 'Could not fetch wanted episodes' };

    const records = result.records || [];
    return {
      success: true,
      totalRecords: result.totalRecords || 0,
      episodes: records.map(e => ({
        seriesTitle: e.series?.title,
        season: e.seasonNumber,
        episode: e.episodeNumber,
        title: e.title,
        airDate: e.airDate
      })),
      result: records.length === 0
        ? 'No missing episodes in Sonarr.'
        : `${result.totalRecords} missing episode(s) in Sonarr:\n${records.map(e =>
          `- ${e.series?.title} S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')} "${e.title}" (aired ${e.airDate || 'unknown'})`
        ).join('\n')}`
    };
  }

  async refreshSeries(data) {
    const body = {};
    if (data.title || data.id) {
      const series = await this.getSeriesDetails(data);
      if (series.series?.id) body.seriesId = series.series.id;
    }
    return this.executeArrCommand('RefreshSeries', body);
  }

  async searchDownloads(data) {
    const body = {};
    if (data.title || data.id) {
      const series = await this.getSeriesDetails(data);
      if (series.series?.id) body.seriesId = series.series.id;
    }
    return this.executeArrCommand('SeriesSearch', body);
  }

  // ─── Formatting ───

  _formatSeries(s) {
    const lines = [
      `${s.title} (${s.year})`,
      s.overview ? s.overview.substring(0, 200) : '',
      `Seasons: ${s.statistics?.seasonCount ?? s.seasonCount ?? '?'} | Episodes: ${s.statistics?.episodeFileCount ?? s.episodeFileCount ?? 0}/${s.statistics?.episodeCount ?? s.episodeCount ?? 0}`,
      `Status: ${s.status} | Monitored: ${s.monitored ? 'Yes' : 'No'}`,
      s.network ? `Network: ${s.network}` : '',
      s.genres?.length ? `Genres: ${s.genres.join(', ')}` : '',
      s.tvdbId ? `TVDB: ${s.tvdbId}` : ''
    ].filter(Boolean);
    return lines.join('\n');
  }
}
