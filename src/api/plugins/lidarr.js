import { ArrBasePlugin } from './arr-base-helper.js';

export default class LidarrPlugin extends ArrBasePlugin {
  constructor(agent) {
    super(agent, {
      name: 'lidarr',
      version: '1.0.0',
      description: 'Manage music artists and albums with Lidarr — search, add, remove, monitor downloads and new releases',
      apiVersion: 'v1',
      envPrefix: 'LIDARR',
      commands: [
        {
          command: 'get_artists',
          description: 'List all music artists currently in the Lidarr library',
          usage: 'get_artists({ filter: "monitored" })',
          examples: [
            'show me all my artists in lidarr',
            'list my lidarr music library',
            'what artists do I have in lidarr',
            'show monitored artists',
            'lidarr artist list',
            'how many artists are in lidarr'
          ]
        },
        {
          command: 'get_artist',
          description: 'Get detailed information about a specific artist in Lidarr',
          usage: 'get_artist({ name: "Radiohead" })',
          examples: [
            'show me details for Radiohead in lidarr',
            'get info about Daft Punk from lidarr',
            'lidarr artist info for Pink Floyd',
            'look up Kendrick Lamar in my lidarr library'
          ]
        },
        {
          command: 'search_artist',
          description: 'Search for a music artist to add to Lidarr (looks up on MusicBrainz)',
          usage: 'search_artist({ query: "Meteor" })',
          examples: [
            'search lidarr for Meteor',
            'find Daft Punk on lidarr',
            'look up Radiohead in lidarr',
            'search for the artist Tool on lidarr',
            'lidarr search Taylor Swift',
            'can you find Metallica on lidarr'
          ]
        },
        {
          command: 'add_artist',
          description: 'Add a new music artist to Lidarr for monitoring and downloading',
          usage: 'add_artist({ name: "Meteor" })',
          examples: [
            'add Meteor to lidarr',
            'download Radiohead discography with lidarr',
            'add that artist to lidarr',
            'put Pink Floyd in lidarr',
            'add Daft Punk to my lidarr music library',
            'lidarr grab Kendrick Lamar',
            'add the band Tool to lidarr'
          ]
        },
        {
          command: 'delete_artist',
          description: 'Remove an artist from the Lidarr library, optionally deleting files',
          usage: 'delete_artist({ name: "Bad Artist", deleteFiles: true })',
          examples: [
            'remove Bad Artist from lidarr',
            'delete that artist from lidarr',
            'lidarr remove Nickelback and delete files',
            'take that artist off lidarr'
          ]
        },
        {
          command: 'get_albums',
          description: 'List albums for an artist or all albums in Lidarr',
          usage: 'get_albums({ artist: "Radiohead" })',
          examples: [
            'show Radiohead albums in lidarr',
            'list albums by Daft Punk on lidarr',
            'what albums do I have from Pink Floyd',
            'lidarr albums for Tool',
            'missing albums for Metallica'
          ]
        },
        {
          command: 'get_calendar',
          description: 'Show upcoming and recently released albums tracked by Lidarr',
          usage: 'get_calendar()',
          examples: [
            'what albums are coming out soon',
            'lidarr upcoming releases',
            'upcoming music on lidarr',
            'any new albums releasing this month',
            'show me the lidarr calendar',
            'new music releases on lidarr'
          ]
        },
        {
          command: 'get_queue',
          description: 'Show the current Lidarr download queue with progress',
          usage: 'get_queue()',
          examples: [
            'show lidarr download queue',
            'what is lidarr downloading',
            'lidarr queue status',
            'any music downloading right now',
            'check lidarr downloads',
            'lidarr download progress'
          ]
        },
        {
          command: 'get_wanted',
          description: 'Show missing or cutoff-unmet albums in Lidarr',
          usage: 'get_wanted()',
          examples: [
            'what albums are missing in lidarr',
            'show lidarr wanted list',
            'missing music in lidarr',
            'lidarr wanted albums',
            'what does lidarr still need to download'
          ]
        },
        {
          command: 'get_history',
          description: 'Show recent Lidarr activity and download history',
          usage: 'get_history({ page: 1 })',
          examples: [
            'show lidarr history',
            'recent lidarr activity',
            'what has lidarr downloaded recently',
            'lidarr download log'
          ]
        },
        {
          command: 'get_health',
          description: 'Check Lidarr system health for issues or warnings',
          usage: 'get_health()',
          examples: [
            'is lidarr healthy',
            'check lidarr health',
            'any lidarr issues',
            'lidarr system status',
            'is lidarr working properly',
            'lidarr health check'
          ]
        },
        {
          command: 'get_status',
          description: 'Get Lidarr server version, uptime, and system information',
          usage: 'get_status()',
          examples: [
            'lidarr version',
            'what version of lidarr is running',
            'lidarr system info',
            'lidarr server status'
          ]
        },
        {
          command: 'refresh',
          description: 'Trigger a metadata refresh for all artists or a specific artist in Lidarr',
          usage: 'refresh({ name: "Radiohead" })',
          examples: [
            'refresh lidarr library',
            'lidarr refresh all artists',
            'update lidarr metadata',
            'refresh Radiohead in lidarr'
          ]
        },
        {
          command: 'search_downloads',
          description: 'Trigger a download search in Lidarr for missing or wanted albums',
          usage: 'search_downloads({ name: "Radiohead" })',
          examples: [
            'search for missing lidarr albums',
            'lidarr search for downloads',
            'find downloads for Radiohead on lidarr',
            'lidarr grab missing music'
          ]
        }
      ],
      intents: {
        listArtists: {
          name: 'List Lidarr Artists',
          description: 'Show the music artist library in Lidarr',
          action: 'get_artists',
          examples: ['show lidarr artists', 'my music collection', 'list all artists', 'what artists do I have']
        },
        searchArtist: {
          name: 'Search Artist on Lidarr',
          description: 'Search for a music artist to add to Lidarr',
          action: 'search_artist',
          examples: ['search for an artist', 'find artist on lidarr', 'look up a band', 'search lidarr music']
        },
        addArtist: {
          name: 'Add Artist to Lidarr',
          description: 'Add a new music artist to Lidarr for downloading',
          action: 'add_artist',
          examples: ['add artist to lidarr', 'download music', 'grab an artist', 'put band in lidarr']
        },
        albumCalendar: {
          name: 'Lidarr Calendar',
          description: 'View upcoming album releases',
          action: 'get_calendar',
          examples: ['upcoming albums', 'music calendar', 'new releases', 'what albums are coming']
        },
        musicQueue: {
          name: 'Lidarr Queue',
          description: 'Check the download queue',
          action: 'get_queue',
          examples: ['lidarr downloads', 'music queue', 'what is downloading', 'download status']
        },
        missingAlbums: {
          name: 'Missing Albums',
          description: 'Find missing albums in Lidarr',
          action: 'get_wanted',
          examples: ['missing albums', 'wanted albums', 'what albums am I missing', 'lidarr wanted']
        },
        musicHealth: {
          name: 'Lidarr Health',
          description: 'Check Lidarr health status',
          action: 'get_health',
          examples: ['lidarr health', 'is lidarr ok', 'lidarr working', 'check lidarr']
        }
      }
    });
  }

  async execute(params) {
    return this._executeAction(params, {
      get_artists: this.getArtists,
      get_artist: this.getArtist,
      search_artist: this.searchArtist,
      add_artist: this.addArtist,
      delete_artist: this.deleteArtist,
      get_albums: this.getAlbums,
      get_calendar: this.getAlbumCalendar,
      get_queue: this.getQueue,
      get_wanted: this.getWanted,
      get_history: this.getHistory,
      get_health: this.getHealth,
      get_status: this.getSystemStatus,
      refresh: this.refreshArtist,
      search_downloads: this.searchDownloads
    });
  }

  // ─── Artist Actions ───

  async getArtists(data) {
    const artists = await this._cachedGet('artists', '/artist');
    if (!artists) return { success: false, error: 'Could not fetch artists from Lidarr' };

    let filtered = Array.isArray(artists) ? artists : [];

    if (data.filter === 'monitored') {
      filtered = filtered.filter(a => a.monitored);
    } else if (data.filter === 'unmonitored') {
      filtered = filtered.filter(a => !a.monitored);
    }

    return {
      success: true,
      total: filtered.length,
      artists: filtered.map(a => ({
        id: a.id,
        name: a.artistName,
        monitored: a.monitored,
        status: a.status,
        albumCount: a.statistics?.albumCount || 0,
        trackCount: a.statistics?.trackFileCount || 0,
        totalTrackCount: a.statistics?.totalTrackCount || 0,
        sizeOnDisk: a.statistics?.sizeOnDisk,
        foreignArtistId: a.foreignArtistId
      })),
      result: `Lidarr library: ${filtered.length} artists${data.filter ? ` (${data.filter})` : ''}:\n${
        filtered.slice(0, 25).map(a => {
          const stats = a.statistics || {};
          return `- ${a.artistName} — ${stats.albumCount || 0} albums, ${stats.trackFileCount || 0}/${stats.totalTrackCount || 0} tracks [${a.status}]`;
        }).join('\n')
      }${filtered.length > 25 ? `\n... and ${filtered.length - 25} more` : ''}`
    };
  }

  async getArtist(data) {
    if (data.id) {
      const artist = await this._cachedGet(`artist_${data.id}`, `/artist/${data.id}`);
      if (!artist) return { success: false, error: `Artist ID ${data.id} not found` };
      return { success: true, artist, result: this._formatArtist(artist) };
    }

    if (data.name || data.title) {
      const artists = await this._cachedGet('artists', '/artist');
      const query = (data.name || data.title).toLowerCase();
      const match = (artists || []).find(a =>
        a.artistName.toLowerCase() === query ||
        a.artistName.toLowerCase().includes(query)
      );
      if (!match) return { success: false, error: `No artist matching "${data.name || data.title}" found in library` };
      return { success: true, artist: match, result: this._formatArtist(match) };
    }

    return { success: false, error: 'Provide an artist name or ID' };
  }

  async searchArtist(data) {
    const term = data.query || data.name || data.title;
    if (!term) return { success: false, error: 'Provide a search query (artist name)' };

    const results = await this._apiRequest('get', '/artist/lookup', null, { term });
    if (!results || results.length === 0) {
      return { success: false, error: `No results found for "${term}"` };
    }

    return {
      success: true,
      results: results.slice(0, 10).map(a => ({
        name: a.artistName,
        foreignArtistId: a.foreignArtistId,
        overview: a.overview?.substring(0, 200),
        status: a.status,
        genres: a.genres
      })),
      result: `Found ${results.length} result(s) for "${term}":\n${
        results.slice(0, 10).map((a, i) => `${i + 1}. ${a.artistName} [${a.status || 'unknown'}]${a.genres?.length ? ` (${a.genres.slice(0, 3).join(', ')})` : ''}`).join('\n')
      }`
    };
  }

  async addArtist(data) {
    let artistData = null;

    if (data.foreignArtistId) {
      const results = await this._apiRequest('get', '/artist/lookup', null, { term: `lidarr:${data.foreignArtistId}` });
      artistData = results?.[0];
    } else if (data.name || data.title || data.query) {
      const term = data.name || data.title || data.query;
      const results = await this._apiRequest('get', '/artist/lookup', null, { term });
      if (!results || results.length === 0) {
        return { success: false, error: `No artist found matching "${term}"` };
      }
      artistData = results[0];
    } else {
      return { success: false, error: 'Provide an artist name to add' };
    }

    if (!artistData) return { success: false, error: 'Could not find artist to add' };

    // Check if already in library
    const existing = await this._cachedGet('artists', '/artist');
    if (existing?.find(a => a.foreignArtistId === artistData.foreignArtistId)) {
      return { success: false, error: `"${artistData.artistName}" is already in your Lidarr library` };
    }

    const rootFolders = await this._apiGet('/rootfolder');
    const profiles = await this._apiGet('/qualityprofile');
    const metaProfiles = await this._apiGet('/metadataprofile');

    if (!rootFolders?.length) return { success: false, error: 'No root folders configured in Lidarr' };
    if (!profiles?.length) return { success: false, error: 'No quality profiles configured in Lidarr' };

    const addPayload = {
      artistName: artistData.artistName,
      foreignArtistId: artistData.foreignArtistId,
      qualityProfileId: data.qualityProfileId || profiles[0].id,
      metadataProfileId: data.metadataProfileId || metaProfiles?.[0]?.id || 1,
      rootFolderPath: data.rootFolder || rootFolders[0].path,
      monitored: data.monitored !== false,
      addOptions: {
        searchForMissingAlbums: data.search !== false
      }
    };

    const result = await this._apiPost('/artist', addPayload);
    this.cache.del('artists');

    return {
      success: true,
      artist: { id: result.id, name: result.artistName, foreignArtistId: result.foreignArtistId },
      result: `Added "${result.artistName}" to Lidarr. ${data.search !== false ? 'Search for missing albums triggered.' : ''}`
    };
  }

  async deleteArtist(data) {
    let artistId = data.id;

    if (!artistId && (data.name || data.title)) {
      const artists = await this._cachedGet('artists', '/artist');
      const query = (data.name || data.title).toLowerCase().replace(/['"\u2018\u2019\u201c\u201d]/g, '');
      const match = (artists || []).find(a => a.artistName.toLowerCase().replace(/['"\u2018\u2019\u201c\u201d]/g, '').includes(query));
      if (!match) return { success: false, error: `No artist matching "${data.name || data.title}" found in library` };
      artistId = match.id;
    }

    if (!artistId) return { success: false, error: 'Provide an artist name or ID to delete' };

    await this._apiDelete(`/artist/${artistId}`, {
      deleteFiles: data.deleteFiles === true
    });

    this.cache.del('artists');
    return {
      success: true,
      result: `Artist removed from Lidarr.${data.deleteFiles ? ' Files deleted.' : ''}`
    };
  }

  async getAlbums(data) {
    let params = {};

    if (data.artist || data.name || data.title) {
      const artist = await this.getArtist({ name: data.artist || data.name || data.title });
      if (artist.artist?.id) {
        params.artistId = artist.artist.id;
      }
    }

    const cacheKey = params.artistId ? `albums_${params.artistId}` : 'albums_all';
    const albums = await this._cachedGet(cacheKey, '/album', params.artistId ? params : null, 120);
    if (!albums) return { success: false, error: 'Could not fetch albums from Lidarr' };

    let filtered = Array.isArray(albums) ? albums : [];
    if (data.filter === 'missing') {
      filtered = filtered.filter(a => a.monitored && a.statistics?.percentOfTracks < 100);
    }

    return {
      success: true,
      total: filtered.length,
      albums: filtered.map(a => ({
        id: a.id,
        title: a.title,
        artist: a.artist?.artistName,
        releaseDate: a.releaseDate,
        monitored: a.monitored,
        trackCount: a.statistics?.totalTrackCount || 0,
        trackFileCount: a.statistics?.trackFileCount || 0,
        percentComplete: a.statistics?.percentOfTracks || 0
      })),
      result: `${filtered.length} album(s):\n${
        filtered.slice(0, 25).map(a => {
          const stats = a.statistics || {};
          return `- ${a.title} by ${a.artist?.artistName || 'Unknown'} — ${stats.trackFileCount || 0}/${stats.totalTrackCount || 0} tracks (${(stats.percentOfTracks || 0).toFixed(0)}%)`;
        }).join('\n')
      }${filtered.length > 25 ? `\n... and ${filtered.length - 25} more` : ''}`
    };
  }

  async getAlbumCalendar(data) {
    const calResult = await this.getCalendar(data.start, data.end);
    if (!calResult.success) return calResult;

    const items = calResult.items;
    return {
      success: true,
      total: items.length,
      albums: items.map(a => ({
        title: a.title,
        artist: a.artist?.artistName,
        releaseDate: a.releaseDate,
        monitored: a.monitored
      })),
      result: items.length === 0
        ? 'No upcoming albums on the Lidarr calendar.'
        : `Lidarr calendar (${items.length} albums):\n${items.map(a =>
          `- ${a.title} by ${a.artist?.artistName || 'Unknown'} — ${a.releaseDate ? new Date(a.releaseDate).toLocaleDateString() : 'TBD'}`
        ).join('\n')}`
    };
  }

  async getWanted(data) {
    const page = data.page || 1;
    const pageSize = data.pageSize || 20;

    const result = await this._cachedGet(`wanted_${page}`, '/wanted/missing', {
      page, pageSize, sortKey: 'releaseDate', sortDirection: 'descending'
    }, 60);

    if (!result) return { success: false, error: 'Could not fetch wanted albums' };

    const records = result.records || [];
    return {
      success: true,
      totalRecords: result.totalRecords || 0,
      albums: records.map(a => ({
        title: a.title,
        artist: a.artist?.artistName,
        releaseDate: a.releaseDate
      })),
      result: records.length === 0
        ? 'No missing albums in Lidarr.'
        : `${result.totalRecords} missing album(s) in Lidarr:\n${records.map(a =>
          `- ${a.title} by ${a.artist?.artistName || 'Unknown'} (${a.releaseDate ? new Date(a.releaseDate).toLocaleDateString() : 'unknown date'})`
        ).join('\n')}`
    };
  }

  async refreshArtist(data) {
    const body = {};
    if (data.name || data.title || data.id) {
      const artist = await this.getArtist(data);
      if (artist.artist?.id) body.artistId = artist.artist.id;
    }
    return this.executeArrCommand('RefreshArtist', body);
  }

  async searchDownloads(data) {
    const body = {};
    if (data.name || data.title || data.id) {
      const artist = await this.getArtist(data);
      if (artist.artist?.id) body.artistId = artist.artist.id;
    }
    return this.executeArrCommand('ArtistSearch', body);
  }

  // ─── Formatting ───

  _formatArtist(a) {
    const stats = a.statistics || {};
    const lines = [
      a.artistName,
      a.overview ? a.overview.substring(0, 200) : '',
      `Albums: ${stats.albumCount || 0} | Tracks: ${stats.trackFileCount || 0}/${stats.totalTrackCount || 0}`,
      `Status: ${a.status} | Monitored: ${a.monitored ? 'Yes' : 'No'}`,
      a.genres?.length ? `Genres: ${a.genres.join(', ')}` : '',
      stats.sizeOnDisk ? `Size: ${(stats.sizeOnDisk / 1073741824).toFixed(1)} GB` : ''
    ].filter(Boolean);
    return lines.join('\n');
  }
}
