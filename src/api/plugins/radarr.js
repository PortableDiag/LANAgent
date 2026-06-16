import { ArrBasePlugin } from './arr-base-helper.js';

export default class RadarrPlugin extends ArrBasePlugin {
  constructor(agent) {
    super(agent, {
      name: 'radarr',
      version: '1.0.0',
      description: 'Manage movies with Radarr — search, add, remove, monitor downloads and upcoming releases',
      apiVersion: 'v3',
      envPrefix: 'RADARR',
      commands: [
        {
          command: 'get_movies',
          description: 'List all movies currently in the Radarr library',
          usage: 'get_movies({ filter: "monitored" })',
          examples: [
            'show me all my movies in radarr',
            'list my radarr movie library',
            'what movies do I have in radarr',
            'show monitored movies',
            'radarr movie list',
            'how many movies are in radarr'
          ]
        },
        {
          command: 'get_movie',
          description: 'Get detailed information about a specific movie in Radarr by title or ID',
          usage: 'get_movie({ title: "Inception" })',
          examples: [
            'show me details for Inception in radarr',
            'get info about The Matrix from radarr',
            'radarr movie info for Interstellar',
            'look up Dune in my radarr library'
          ]
        },
        {
          command: 'search_movie',
          description: 'Search for a movie to add to Radarr (looks up on TMDB/online)',
          usage: 'search_movie({ query: "Oppenheimer" })',
          examples: [
            'search radarr for Oppenheimer',
            'find Dune Part Two on radarr',
            'look up Barbie movie in radarr',
            'search for the new Batman movie',
            'radarr search Deadpool',
            'can you find Gladiator 2 on radarr'
          ]
        },
        {
          command: 'add_movie',
          description: 'Add a new movie to Radarr for monitoring and downloading',
          usage: 'add_movie({ title: "Oppenheimer", tmdbId: 872585 })',
          examples: [
            'add Oppenheimer to radarr',
            'download Dune Part Two with radarr',
            'add that movie to radarr',
            'put Barbie in radarr',
            'add the new Mission Impossible to radarr',
            'radarr grab Gladiator 2'
          ]
        },
        {
          command: 'delete_movie',
          description: 'Remove a movie from the Radarr library, optionally deleting files',
          usage: 'delete_movie({ title: "Bad Movie", deleteFiles: true })',
          examples: [
            'remove Bad Movie from radarr',
            'delete that movie from radarr',
            'radarr remove The Room and delete files',
            'take that off radarr'
          ]
        },
        {
          command: 'get_calendar',
          description: 'Show upcoming and recently released movies tracked by Radarr',
          usage: 'get_calendar()',
          examples: [
            'what movies are coming out soon',
            'radarr upcoming releases',
            'upcoming movies on radarr',
            'what releases does radarr have coming',
            'show me the radarr calendar',
            'any new movies releasing this month'
          ]
        },
        {
          command: 'get_queue',
          description: 'Show the current Radarr download queue with progress',
          usage: 'get_queue()',
          examples: [
            'show radarr download queue',
            'what is radarr downloading',
            'radarr queue status',
            'any movies downloading right now',
            'check radarr downloads',
            'radarr download progress'
          ]
        },
        {
          command: 'get_history',
          description: 'Show recent Radarr activity and download history',
          usage: 'get_history({ page: 1 })',
          examples: [
            'show radarr history',
            'recent radarr activity',
            'what has radarr downloaded recently',
            'radarr download log'
          ]
        },
        {
          command: 'get_health',
          description: 'Check Radarr system health for issues or warnings',
          usage: 'get_health()',
          examples: [
            'is radarr healthy',
            'check radarr health',
            'any radarr issues',
            'radarr system status',
            'is radarr working properly',
            'radarr health check'
          ]
        },
        {
          command: 'get_status',
          description: 'Get Radarr server version, uptime, and system information',
          usage: 'get_status()',
          examples: [
            'radarr version',
            'what version of radarr is running',
            'radarr system info',
            'radarr server status'
          ]
        },
        {
          command: 'refresh',
          description: 'Trigger a metadata refresh for all movies or a specific movie in Radarr',
          usage: 'refresh({ title: "Inception" })',
          examples: [
            'refresh radarr library',
            'radarr refresh all movies',
            'update radarr metadata',
            'refresh Inception in radarr'
          ]
        },
        {
          command: 'search_downloads',
          description: 'Trigger a download search in Radarr for missing or wanted movies',
          usage: 'search_downloads({ title: "Inception" })',
          examples: [
            'search for missing radarr movies',
            'radarr search for downloads',
            'find downloads for Inception on radarr',
            'radarr grab missing movies'
          ]
        }
      ],
      intents: {
        listMovies: {
          name: 'List Radarr Movies',
          description: 'Show the movie library in Radarr',
          action: 'get_movies',
          examples: ['show radarr movies', 'my movie collection', 'list all movies', 'what movies do I have']
        },
        searchMovie: {
          name: 'Search Movie on Radarr',
          description: 'Search for a movie to add to Radarr',
          action: 'search_movie',
          examples: ['search for a movie', 'find movie on radarr', 'look up a film', 'search radarr']
        },
        addMovie: {
          name: 'Add Movie to Radarr',
          description: 'Add a new movie to Radarr for downloading',
          action: 'add_movie',
          examples: ['add movie to radarr', 'download a movie', 'grab a film', 'put movie in radarr']
        },
        movieCalendar: {
          name: 'Radarr Calendar',
          description: 'View upcoming movie releases',
          action: 'get_calendar',
          examples: ['upcoming movies', 'movie calendar', 'new releases', 'what movies are coming']
        },
        movieQueue: {
          name: 'Radarr Queue',
          description: 'Check the download queue',
          action: 'get_queue',
          examples: ['radarr downloads', 'movie queue', 'what is downloading', 'download status']
        },
        movieHealth: {
          name: 'Radarr Health',
          description: 'Check Radarr health status',
          action: 'get_health',
          examples: ['radarr health', 'is radarr ok', 'radarr working', 'check radarr']
        }
      }
    });
  }

  async execute(params) {
    return this._executeAction(params, {
      get_movies: this.getMovies,
      get_movie: this.getMovie,
      search_movie: this.searchMovie,
      add_movie: this.addMovie,
      delete_movie: this.deleteMovie,
      get_calendar: this.getMovieCalendar,
      get_queue: this.getQueue,
      get_history: this.getHistory,
      get_health: this.getHealth,
      get_status: this.getSystemStatus,
      refresh: this.refreshMovie,
      search_downloads: this.searchDownloads
    });
  }

  // ─── Movie Actions ───

  async getMovies(data) {
    const movies = await this._cachedGet('movies', '/movie');
    if (!movies) return { success: false, error: 'Could not fetch movies from Radarr' };

    let filtered = Array.isArray(movies) ? movies : [];

    if (data.filter === 'monitored') {
      filtered = filtered.filter(m => m.monitored);
    } else if (data.filter === 'unmonitored') {
      filtered = filtered.filter(m => !m.monitored);
    } else if (data.filter === 'missing') {
      filtered = filtered.filter(m => !m.hasFile && m.monitored);
    } else if (data.filter === 'downloaded') {
      filtered = filtered.filter(m => m.hasFile);
    }

    return {
      success: true,
      total: filtered.length,
      movies: filtered.map(m => ({
        id: m.id,
        title: m.title,
        year: m.year,
        monitored: m.monitored,
        hasFile: m.hasFile,
        quality: m.movieFile?.quality?.quality?.name,
        sizeOnDisk: m.sizeOnDisk,
        tmdbId: m.tmdbId,
        imdbId: m.imdbId,
        status: m.status
      })),
      result: `Radarr library: ${filtered.length} movies${data.filter ? ` (${data.filter})` : ''}:\n${
        filtered.slice(0, 25).map(m => `- ${m.title} (${m.year}) ${m.hasFile ? '[downloaded]' : '[missing]'} ${m.monitored ? '' : '[unmonitored]'}`).join('\n')
      }${filtered.length > 25 ? `\n... and ${filtered.length - 25} more` : ''}`
    };
  }

  async getMovie(data) {
    if (data.id) {
      const movie = await this._cachedGet(`movie_${data.id}`, `/movie/${data.id}`);
      if (!movie) return { success: false, error: `Movie ID ${data.id} not found` };
      return { success: true, movie, result: this._formatMovie(movie) };
    }

    if (data.title || data.name) {
      const movies = await this._cachedGet('movies', '/movie');
      const query = (data.title || data.name).toLowerCase();
      const match = (movies || []).find(m =>
        m.title.toLowerCase() === query ||
        m.title.toLowerCase().includes(query) ||
        (m.originalTitle && m.originalTitle.toLowerCase().includes(query))
      );
      if (!match) return { success: false, error: `No movie matching "${data.title || data.name}" found in library` };
      return { success: true, movie: match, result: this._formatMovie(match) };
    }

    return { success: false, error: 'Provide a movie title or ID' };
  }

  async searchMovie(data) {
    if (!data.query && !data.title && !data.name) {
      return { success: false, error: 'Provide a search query (movie title)' };
    }

    const term = data.query || data.title || data.name;
    const results = await this._apiRequest('get', '/movie/lookup', null, { term });

    if (!results || results.length === 0) {
      return { success: false, error: `No results found for "${term}"` };
    }

    return {
      success: true,
      results: results.slice(0, 10).map(m => ({
        title: m.title,
        year: m.year,
        tmdbId: m.tmdbId,
        imdbId: m.imdbId,
        overview: m.overview?.substring(0, 200),
        runtime: m.runtime,
        ratings: m.ratings
      })),
      result: `Found ${results.length} result(s) for "${term}":\n${
        results.slice(0, 10).map((m, i) => `${i + 1}. ${m.title} (${m.year}) [tmdb:${m.tmdbId}]`).join('\n')
      }`
    };
  }

  async addMovie(data) {
    let movieData = null;

    // If we have a tmdbId, look it up directly
    if (data.tmdbId) {
      const results = await this._apiRequest('get', '/movie/lookup', null, { term: `tmdb:${data.tmdbId}` });
      movieData = results?.[0];
    } else if (data.title || data.name || data.query) {
      // Search by title and take the best match
      const term = data.title || data.name || data.query;
      const results = await this._apiRequest('get', '/movie/lookup', null, { term });
      if (!results || results.length === 0) {
        return { success: false, error: `No movie found matching "${term}"` };
      }
      movieData = results[0];
    } else {
      return { success: false, error: 'Provide a movie title or tmdbId to add' };
    }

    if (!movieData) return { success: false, error: 'Could not find movie to add' };

    // Check if already in library
    const existing = await this._cachedGet('movies', '/movie');
    if (existing?.find(m => m.tmdbId === movieData.tmdbId)) {
      return { success: false, error: `"${movieData.title}" is already in your Radarr library` };
    }

    // Get root folder and quality profile
    const rootFolders = await this._apiGet('/rootfolder');
    const profiles = await this._apiGet('/qualityprofile');

    if (!rootFolders?.length) return { success: false, error: 'No root folders configured in Radarr' };
    if (!profiles?.length) return { success: false, error: 'No quality profiles configured in Radarr' };

    const addPayload = {
      title: movieData.title,
      tmdbId: movieData.tmdbId,
      year: movieData.year,
      qualityProfileId: data.qualityProfileId || profiles[0].id,
      rootFolderPath: data.rootFolder || rootFolders[0].path,
      monitored: data.monitored !== false,
      minimumAvailability: data.minimumAvailability || 'released',
      addOptions: {
        searchForMovie: data.search !== false
      }
    };

    const result = await this._apiPost('/movie', addPayload);
    this.cache.del('movies');

    return {
      success: true,
      movie: { id: result.id, title: result.title, year: result.year, tmdbId: result.tmdbId },
      result: `Added "${result.title} (${result.year})" to Radarr. ${data.search !== false ? 'Search for downloads triggered.' : ''}`
    };
  }

  async deleteMovie(data) {
    let movieId = data.id;

    if (!movieId && (data.title || data.name)) {
      const movies = await this._cachedGet('movies', '/movie');
      const query = (data.title || data.name).toLowerCase();
      const match = (movies || []).find(m => m.title.toLowerCase().includes(query));
      if (!match) return { success: false, error: `No movie matching "${data.title || data.name}" found in library` };
      movieId = match.id;
    }

    if (!movieId) return { success: false, error: 'Provide a movie title or ID to delete' };

    await this._apiDelete(`/movie/${movieId}`, {
      deleteFiles: data.deleteFiles === true,
      addImportExclusion: data.exclude === true
    });

    this.cache.del('movies');
    return {
      success: true,
      result: `Movie removed from Radarr.${data.deleteFiles ? ' Files deleted.' : ''}`
    };
  }

  async getMovieCalendar(data) {
    const calResult = await this.getCalendar(data.start, data.end);
    if (!calResult.success) return calResult;

    const items = calResult.items;
    return {
      success: true,
      total: items.length,
      movies: items.map(m => ({
        title: m.title,
        year: m.year,
        releaseDate: m.physicalRelease || m.digitalRelease || m.inCinemas,
        monitored: m.monitored,
        hasFile: m.hasFile,
        status: m.status
      })),
      result: items.length === 0
        ? 'No upcoming movies on the Radarr calendar.'
        : `Radarr calendar (${items.length} movies):\n${items.map(m => {
          const date = m.physicalRelease || m.digitalRelease || m.inCinemas || 'TBD';
          return `- ${m.title} (${m.year}) — ${new Date(date).toLocaleDateString()} ${m.hasFile ? '[downloaded]' : ''}`;
        }).join('\n')}`
    };
  }

  async refreshMovie(data) {
    const body = {};
    if (data.title || data.id) {
      const movie = (await this.getMovie(data));
      if (movie.movie?.id) body.movieId = movie.movie.id;
    }
    return this.executeArrCommand('RefreshMovie', body);
  }

  async searchDownloads(data) {
    const body = {};
    if (data.title || data.id) {
      const movie = (await this.getMovie(data));
      if (movie.movie?.id) body.movieIds = [movie.movie.id];
    }
    return this.executeArrCommand('MoviesSearch', body);
  }

  // ─── Formatting helpers ───

  _formatMovie(m) {
    const lines = [
      `${m.title} (${m.year})`,
      m.overview ? m.overview.substring(0, 200) : '',
      `Status: ${m.status} | Monitored: ${m.monitored ? 'Yes' : 'No'}`,
      `File: ${m.hasFile ? 'Downloaded' : 'Missing'}`,
      m.runtime ? `Runtime: ${m.runtime} min` : '',
      m.genres?.length ? `Genres: ${m.genres.join(', ')}` : '',
      m.tmdbId ? `TMDB: ${m.tmdbId}` : '',
      m.imdbId ? `IMDB: ${m.imdbId}` : ''
    ].filter(Boolean);
    return lines.join('\n');
  }
}
