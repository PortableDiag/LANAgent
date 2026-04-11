import { ArrBasePlugin } from './arr-base-helper.js';

export default class ReadarrPlugin extends ArrBasePlugin {
  constructor(agent) {
    super(agent, {
      name: 'readarr',
      version: '1.0.0',
      description: 'Manage books and authors with Readarr — search, add, remove, monitor downloads and new releases',
      apiVersion: 'v1',
      envPrefix: 'READARR',
      commands: [
        {
          command: 'get_authors',
          description: 'List and display all authors currently in the Readarr library — view existing collection',
          usage: 'get_authors({ filter: "monitored" })',
          examples: [
            'show me all my authors in readarr',
            'list my readarr book library',
            'what authors do I have in readarr',
            'show monitored authors',
            'readarr author list',
            'how many authors are in readarr',
            'who is in my readarr library',
            'display my readarr authors',
            'view all readarr authors',
            'what is in my readarr collection',
            'show me my readarr library'
          ]
        },
        {
          command: 'get_author',
          description: 'Get detailed information about a specific author in Readarr',
          usage: 'get_author({ name: "Brandon Sanderson" })',
          examples: [
            'show me details for Brandon Sanderson in readarr',
            'get info about Stephen King from readarr',
            'readarr author info for J.R.R. Tolkien',
            'look up Patrick Rothfuss in my readarr library'
          ]
        },
        {
          command: 'search_author',
          description: 'Search for an author to add to Readarr (looks up on GoodReads)',
          usage: 'search_author({ query: "Andy Weir" })',
          examples: [
            'search readarr for Andy Weir',
            'find Brandon Sanderson on readarr',
            'look up Stephen King in readarr',
            'search for the author of Dune on readarr',
            'readarr search Neil Gaiman',
            'can you find Terry Pratchett on readarr'
          ]
        },
        {
          command: 'add_author',
          description: 'Add a new author to Readarr for monitoring and downloading their books',
          usage: 'add_author({ name: "Andy Weir" })',
          examples: [
            'add Andy Weir to readarr',
            'download Brandon Sanderson books with readarr',
            'add that author to readarr',
            'put Stephen King in readarr',
            'add Neil Gaiman to my readarr library',
            'readarr grab Terry Pratchett',
            'add the author of Project Hail Mary to readarr'
          ]
        },
        {
          command: 'delete_author',
          description: 'Remove and delete an author from the Readarr library, optionally deleting files',
          usage: 'delete_author({ name: "Bad Author", deleteFiles: true })',
          examples: [
            'remove Andy Weir from readarr',
            'delete Stephen King from readarr',
            'remove that author from readarr',
            'delete that writer from readarr',
            'readarr remove author and delete files',
            'take that author off readarr',
            'get rid of that author in readarr'
          ]
        },
        {
          command: 'get_books',
          description: 'List books for an author or all books in Readarr',
          usage: 'get_books({ author: "Brandon Sanderson" })',
          examples: [
            'show Brandon Sanderson books in readarr',
            'list books by Stephen King on readarr',
            'what books do I have from Tolkien',
            'readarr books for Neil Gaiman',
            'missing books for Andy Weir'
          ]
        },
        {
          command: 'get_calendar',
          description: 'Show upcoming and recently released books tracked by Readarr',
          usage: 'get_calendar()',
          examples: [
            'what books are coming out soon',
            'readarr upcoming releases',
            'upcoming books on readarr',
            'any new books releasing this month',
            'show me the readarr calendar',
            'new book releases on readarr'
          ]
        },
        {
          command: 'get_queue',
          description: 'Show the current Readarr download queue with progress',
          usage: 'get_queue()',
          examples: [
            'show readarr download queue',
            'what is readarr downloading',
            'readarr queue status',
            'any books downloading right now',
            'check readarr downloads',
            'readarr download progress'
          ]
        },
        {
          command: 'get_wanted',
          description: 'Show missing or cutoff-unmet books in Readarr',
          usage: 'get_wanted()',
          examples: [
            'what books are missing in readarr',
            'show readarr wanted list',
            'missing books in readarr',
            'readarr wanted books',
            'what does readarr still need to download'
          ]
        },
        {
          command: 'get_history',
          description: 'Show recent Readarr activity and download history',
          usage: 'get_history({ page: 1 })',
          examples: [
            'show readarr history',
            'recent readarr activity',
            'what has readarr downloaded recently',
            'readarr download log'
          ]
        },
        {
          command: 'get_health',
          description: 'Check Readarr system health for issues or warnings',
          usage: 'get_health()',
          examples: [
            'is readarr healthy',
            'check readarr health',
            'any readarr issues',
            'readarr system status',
            'is readarr working properly',
            'readarr health check'
          ]
        },
        {
          command: 'get_status',
          description: 'Get Readarr server version, uptime, and system information',
          usage: 'get_status()',
          examples: [
            'readarr version',
            'what version of readarr is running',
            'readarr system info',
            'readarr server status'
          ]
        },
        {
          command: 'refresh',
          description: 'Trigger a metadata refresh for all authors or a specific author in Readarr',
          usage: 'refresh({ name: "Brandon Sanderson" })',
          examples: [
            'refresh readarr library',
            'readarr refresh all authors',
            'update readarr metadata',
            'refresh Brandon Sanderson in readarr'
          ]
        },
        {
          command: 'search_downloads',
          description: 'Trigger a download search in Readarr for missing or wanted books',
          usage: 'search_downloads({ name: "Brandon Sanderson" })',
          examples: [
            'search for missing readarr books',
            'readarr search for downloads',
            'find downloads for Brandon Sanderson on readarr',
            'readarr grab missing books'
          ]
        }
      ],
      intents: {
        listAuthors: {
          name: 'List Readarr Authors',
          description: 'Show and display the existing author library in Readarr — view current collection',
          action: 'get_authors',
          examples: ['show readarr authors', 'list all authors in readarr', 'what authors do I have', 'display my readarr collection', 'who is in my readarr']
        },
        searchAuthor: {
          name: 'Search Author on Readarr',
          description: 'Search for an author to add to Readarr',
          action: 'search_author',
          examples: ['search for an author', 'find author on readarr', 'look up a writer', 'search readarr books']
        },
        addAuthor: {
          name: 'Add Author to Readarr',
          description: 'Add a new author to Readarr for downloading their books',
          action: 'add_author',
          examples: ['add author to readarr', 'put a new writer in readarr', 'grab a writer for readarr', 'add new author to readarr']
        },
        bookCalendar: {
          name: 'Readarr Calendar',
          description: 'View upcoming book releases',
          action: 'get_calendar',
          examples: ['upcoming books', 'book calendar', 'new releases', 'what books are coming']
        },
        bookQueue: {
          name: 'Readarr Queue',
          description: 'Check the download queue',
          action: 'get_queue',
          examples: ['readarr downloads', 'book queue', 'what is downloading', 'download status']
        },
        missingBooks: {
          name: 'Missing Books',
          description: 'Find missing books in Readarr',
          action: 'get_wanted',
          examples: ['missing books', 'wanted books', 'what books am I missing', 'readarr wanted']
        },
        bookHealth: {
          name: 'Readarr Health',
          description: 'Check Readarr health status',
          action: 'get_health',
          examples: ['readarr health', 'is readarr ok', 'readarr working', 'check readarr']
        }
      }
    });
  }

  async execute(params) {
    return this._executeAction(params, {
      get_authors: this.getAuthors,
      get_author: this.getAuthor,
      search_author: this.searchAuthor,
      add_author: this.addAuthor,
      delete_author: this.deleteAuthor,
      get_books: this.getBooks,
      get_calendar: this.getBookCalendar,
      get_queue: this.getQueue,
      get_wanted: this.getWanted,
      get_history: this.getHistory,
      get_health: this.getHealth,
      get_status: this.getSystemStatus,
      refresh: this.refreshAuthor,
      search_downloads: this.searchDownloads
    });
  }

  // ─── Author Actions ───

  async getAuthors(data) {
    const authors = await this._cachedGet('authors', '/author');
    if (!authors) return { success: false, error: 'Could not fetch authors from Readarr' };

    let filtered = Array.isArray(authors) ? authors : [];

    if (data.filter === 'monitored') {
      filtered = filtered.filter(a => a.monitored);
    } else if (data.filter === 'unmonitored') {
      filtered = filtered.filter(a => !a.monitored);
    }

    return {
      success: true,
      total: filtered.length,
      authors: filtered.map(a => ({
        id: a.id,
        name: a.authorName,
        monitored: a.monitored,
        status: a.status,
        bookCount: a.statistics?.bookCount || 0,
        bookFileCount: a.statistics?.bookFileCount || 0,
        totalBookCount: a.statistics?.totalBookCount || 0,
        sizeOnDisk: a.statistics?.sizeOnDisk,
        foreignAuthorId: a.foreignAuthorId
      })),
      result: `Readarr library: ${filtered.length} authors${data.filter ? ` (${data.filter})` : ''}:\n${
        filtered.slice(0, 25).map(a => {
          const stats = a.statistics || {};
          return `- ${a.authorName} — ${stats.bookFileCount || 0}/${stats.totalBookCount || 0} books [${a.status}]`;
        }).join('\n')
      }${filtered.length > 25 ? `\n... and ${filtered.length - 25} more` : ''}`
    };
  }

  async getAuthor(data) {
    if (data.id) {
      const author = await this._cachedGet(`author_${data.id}`, `/author/${data.id}`);
      if (!author) return { success: false, error: `Author ID ${data.id} not found` };
      return { success: true, author, result: this._formatAuthor(author) };
    }

    const authorName = data.name || data.title || data.author || data.query;
    if (authorName) {
      const authors = await this._cachedGet('authors', '/author');
      const query = authorName.toLowerCase();
      const match = (authors || []).find(a =>
        a.authorName.toLowerCase() === query ||
        a.authorName.toLowerCase().includes(query)
      );
      if (!match) return { success: false, error: `No author matching "${authorName}" found in library` };
      return { success: true, author: match, result: this._formatAuthor(match) };
    }

    return { success: false, error: 'Provide an author name or ID' };
  }

  async searchAuthor(data) {
    const term = data.query || data.name || data.title || data.author;
    if (!term) return { success: false, error: 'Provide a search query (author name)' };

    const results = await this._apiRequest('get', '/author/lookup', null, { term });
    if (!results || results.length === 0) {
      return { success: false, error: `No results found for "${term}"` };
    }

    return {
      success: true,
      results: results.slice(0, 10).map(a => ({
        name: a.authorName,
        foreignAuthorId: a.foreignAuthorId,
        overview: a.overview?.substring(0, 200),
        status: a.status,
        genres: a.genres
      })),
      result: `Found ${results.length} result(s) for "${term}":\n${
        results.slice(0, 10).map((a, i) => `${i + 1}. ${a.authorName}${a.overview ? ` — ${a.overview.substring(0, 80)}...` : ''}`).join('\n')
      }`
    };
  }

  async addAuthor(data) {
    let authorData = null;

    if (data.foreignAuthorId) {
      const results = await this._apiRequest('get', '/author/lookup', null, { term: `readarr:${data.foreignAuthorId}` });
      authorData = results?.[0];
    } else if (data.name || data.title || data.query || data.author) {
      const term = data.name || data.title || data.query || data.author;
      const results = await this._apiRequest('get', '/author/lookup', null, { term });
      if (!results || results.length === 0) {
        return { success: false, error: `No author found matching "${term}"` };
      }
      authorData = results[0];
    } else {
      return { success: false, error: 'Provide an author name to add' };
    }

    if (!authorData) return { success: false, error: 'Could not find author to add' };

    // Check if already in library
    const existing = await this._cachedGet('authors', '/author');
    if (existing?.find(a => a.foreignAuthorId === authorData.foreignAuthorId)) {
      return { success: false, error: `"${authorData.authorName}" is already in your Readarr library` };
    }

    const rootFolders = await this._apiGet('/rootfolder');
    const profiles = await this._apiGet('/qualityprofile');
    const metaProfiles = await this._apiGet('/metadataprofile');

    if (!rootFolders?.length) return { success: false, error: 'No root folders configured in Readarr' };
    if (!profiles?.length) return { success: false, error: 'No quality profiles configured in Readarr' };

    const addPayload = {
      authorName: authorData.authorName,
      foreignAuthorId: authorData.foreignAuthorId,
      qualityProfileId: data.qualityProfileId || profiles[0].id,
      metadataProfileId: data.metadataProfileId || metaProfiles?.[0]?.id || 1,
      rootFolderPath: data.rootFolder || rootFolders[0].path,
      monitored: data.monitored !== false,
      addOptions: {
        searchForMissingBooks: data.search !== false
      }
    };

    const result = await this._apiPost('/author', addPayload);
    this.cache.del('authors');

    return {
      success: true,
      author: { id: result.id, name: result.authorName, foreignAuthorId: result.foreignAuthorId },
      result: `Added "${result.authorName}" to Readarr. ${data.search !== false ? 'Search for missing books triggered.' : ''}`
    };
  }

  async deleteAuthor(data) {
    let authorId = data.id;

    if (!authorId && (data.name || data.title || data.author)) {
      const authors = await this._cachedGet('authors', '/author');
      const query = (data.name || data.title || data.author).toLowerCase();
      const match = (authors || []).find(a => a.authorName.toLowerCase().includes(query));
      if (!match) return { success: false, error: `No author matching "${data.name || data.title}" found in library` };
      authorId = match.id;
    }

    if (!authorId) return { success: false, error: 'Provide an author name or ID to delete' };

    await this._apiDelete(`/author/${authorId}`, {
      deleteFiles: data.deleteFiles === true
    });

    this.cache.del('authors');
    return {
      success: true,
      result: `Author removed from Readarr.${data.deleteFiles ? ' Files deleted.' : ''}`
    };
  }

  async getBooks(data) {
    let params = {};

    if (data.author || data.name || data.title) {
      const author = await this.getAuthor({ name: data.author || data.name || data.title });
      if (author.author?.id) {
        params.authorId = author.author.id;
      }
    }

    const cacheKey = params.authorId ? `books_${params.authorId}` : 'books_all';
    const books = await this._cachedGet(cacheKey, '/book', params.authorId ? params : null, 120);
    if (!books) return { success: false, error: 'Could not fetch books from Readarr' };

    let filtered = Array.isArray(books) ? books : [];
    if (data.filter === 'missing') {
      filtered = filtered.filter(b => b.monitored && !b.statistics?.bookFileCount);
    }

    return {
      success: true,
      total: filtered.length,
      books: filtered.map(b => ({
        id: b.id,
        title: b.title,
        author: b.authorTitle || b.author?.authorName,
        releaseDate: b.releaseDate,
        monitored: b.monitored,
        hasFile: (b.statistics?.bookFileCount || 0) > 0,
        pageCount: b.pageCount
      })),
      result: `${filtered.length} book(s):\n${
        filtered.slice(0, 25).map(b =>
          `- ${b.title} by ${b.authorTitle || b.author?.authorName || 'Unknown'} ${(b.statistics?.bookFileCount || 0) > 0 ? '[downloaded]' : '[missing]'}`
        ).join('\n')
      }${filtered.length > 25 ? `\n... and ${filtered.length - 25} more` : ''}`
    };
  }

  async getBookCalendar(data) {
    const calResult = await this.getCalendar(data.start, data.end);
    if (!calResult.success) return calResult;

    const items = calResult.items;
    return {
      success: true,
      total: items.length,
      books: items.map(b => ({
        title: b.title,
        author: b.authorTitle || b.author?.authorName,
        releaseDate: b.releaseDate
      })),
      result: items.length === 0
        ? 'No upcoming books on the Readarr calendar.'
        : `Readarr calendar (${items.length} books):\n${items.map(b =>
          `- ${b.title} by ${b.authorTitle || b.author?.authorName || 'Unknown'} — ${b.releaseDate ? new Date(b.releaseDate).toLocaleDateString() : 'TBD'}`
        ).join('\n')}`
    };
  }

  async getWanted(data) {
    const page = data.page || 1;
    const pageSize = data.pageSize || 20;

    const result = await this._cachedGet(`wanted_${page}`, '/wanted/missing', {
      page, pageSize, sortKey: 'releaseDate', sortDirection: 'descending'
    }, 60);

    if (!result) return { success: false, error: 'Could not fetch wanted books' };

    const records = result.records || [];
    return {
      success: true,
      totalRecords: result.totalRecords || 0,
      books: records.map(b => ({
        title: b.title,
        author: b.authorTitle || b.author?.authorName,
        releaseDate: b.releaseDate
      })),
      result: records.length === 0
        ? 'No missing books in Readarr.'
        : `${result.totalRecords} missing book(s) in Readarr:\n${records.map(b =>
          `- ${b.title} by ${b.authorTitle || b.author?.authorName || 'Unknown'} (${b.releaseDate ? new Date(b.releaseDate).toLocaleDateString() : 'unknown date'})`
        ).join('\n')}`
    };
  }

  async refreshAuthor(data) {
    const body = {};
    if (data.name || data.title || data.id) {
      const author = await this.getAuthor(data);
      if (author.author?.id) body.authorId = author.author.id;
    }
    return this.executeArrCommand('RefreshAuthor', body);
  }

  async searchDownloads(data) {
    const body = {};
    if (data.name || data.title || data.id) {
      const author = await this.getAuthor(data);
      if (author.author?.id) body.authorId = author.author.id;
    }
    return this.executeArrCommand('AuthorSearch', body);
  }

  // ─── Formatting ───

  _formatAuthor(a) {
    const stats = a.statistics || {};
    const lines = [
      a.authorName,
      a.overview ? a.overview.substring(0, 200) : '',
      `Books: ${stats.bookFileCount || 0}/${stats.totalBookCount || 0}`,
      `Status: ${a.status} | Monitored: ${a.monitored ? 'Yes' : 'No'}`,
      a.genres?.length ? `Genres: ${a.genres.join(', ')}` : '',
      stats.sizeOnDisk ? `Size: ${(stats.sizeOnDisk / 1073741824).toFixed(1)} GB` : ''
    ].filter(Boolean);
    return lines.join('\n');
  }
}
