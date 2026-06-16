import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';
import { PluginSettings } from '../../models/PluginSettings.js';
import { decrypt } from '../../utils/encryption.js';

export default class CalibrePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'calibre';
    this.version = '1.0.0';
    this.description = 'Browse and search your Calibre eBook library — find books by author, tag, series, rating, and more';

    this.requiredCredentials = [
      { key: 'url', label: 'Calibre Server URL', envVar: 'CALIBRE_URL', required: true },
      { key: 'username', label: 'Username (if auth enabled)', envVar: 'CALIBRE_USERNAME', required: false },
      { key: 'password', label: 'Password (if auth enabled)', envVar: 'CALIBRE_PASSWORD', required: false }
    ];

    this.config = {
      url: null,
      username: null,
      password: null,
      timeout: 15000
    };

    this.cache = new NodeCache({ stdTTL: 120, checkperiod: 30 });
    this.defaultLibrary = null;

    this.commands = [
      // ─── Library Info ───
      {
        command: 'get_libraries',
        description: 'List all available Calibre libraries',
        usage: 'get_libraries()',
        examples: [
          'show calibre libraries',
          'what libraries are in calibre',
          'list my ebook libraries',
          'calibre library list'
        ]
      },
      {
        command: 'library_stats',
        description: 'Get statistics for a Calibre library including total books, authors, tags, and series counts',
        usage: 'library_stats({ library: "Calibre_Library" })',
        examples: [
          'calibre library stats',
          'how many books are in calibre',
          'how many authors in my library',
          'calibre collection statistics',
          'ebook library summary'
        ]
      },

      // ─── Search ───
      {
        command: 'search_books',
        description: 'Search for books in the Calibre library by title, author, tag, or any field',
        usage: 'search_books({ query: "Foundation" })',
        examples: [
          'search calibre for Foundation',
          'find books by Asimov in calibre',
          'search my ebooks for sci-fi',
          'look up Dune in calibre',
          'do I have any Terry Pratchett books'
        ]
      },

      // ─── Book Details ───
      {
        command: 'get_book',
        description: 'Get detailed metadata for a specific book by ID including formats, tags, and description',
        usage: 'get_book({ bookId: 42 })',
        examples: [
          'get details for book 42 in calibre',
          'show me info about that calibre book',
          'calibre book details'
        ]
      },
      {
        command: 'get_formats',
        description: 'List available file formats for a specific book (EPUB, PDF, MOBI, etc.)',
        usage: 'get_formats({ bookId: 42 })',
        examples: [
          'what formats does book 42 have',
          'is this book available as epub',
          'calibre book formats',
          'what file types for this book'
        ]
      },
      {
        command: 'get_download_link',
        description: 'Get a download URL for a book in a specific format',
        usage: 'get_download_link({ bookId: 42, format: "EPUB" })',
        examples: [
          'download book 42 as epub',
          'get the pdf link for this book',
          'calibre download link',
          'give me the epub for that book'
        ]
      },

      // ─── Browse Categories ───
      {
        command: 'browse_categories',
        description: 'List all browsable categories in the Calibre library (authors, tags, series, publishers, etc.)',
        usage: 'browse_categories()',
        examples: [
          'what categories are in calibre',
          'browse calibre library',
          'show calibre categories',
          'calibre browse options'
        ]
      },
      {
        command: 'browse_category',
        description: 'List items within a specific category (e.g., all authors, all tags, all series)',
        usage: 'browse_category({ category: "authors", limit: 25 })',
        examples: [
          'list all authors in calibre',
          'show all tags in calibre',
          'what series are in my library',
          'browse calibre publishers',
          'show calibre genres'
        ]
      },

      // ─── Browse by Field ───
      {
        command: 'books_by_author',
        description: 'Get all books by a specific author',
        usage: 'books_by_author({ author: "Isaac Asimov" })',
        examples: [
          'show books by Isaac Asimov',
          'what books do I have by Tolkien',
          'calibre books by Stephen King',
          'list all books by that author'
        ]
      },
      {
        command: 'books_by_tag',
        description: 'Get all books with a specific tag or genre',
        usage: 'books_by_tag({ tag: "Science Fiction" })',
        examples: [
          'show science fiction books in calibre',
          'find all fantasy ebooks',
          'calibre books tagged horror',
          'what books are tagged programming'
        ]
      },
      {
        command: 'books_by_series',
        description: 'Get all books in a specific series',
        usage: 'books_by_series({ series: "Discworld" })',
        examples: [
          'show the Discworld series',
          'list books in the Foundation series',
          'calibre series books',
          'what books are in this series'
        ]
      },
      {
        command: 'books_by_publisher',
        description: 'Get all books from a specific publisher',
        usage: 'books_by_publisher({ publisher: "Penguin" })',
        examples: [
          'show books from Penguin',
          'calibre books by publisher',
          'list books published by Tor'
        ]
      },
      {
        command: 'books_by_rating',
        description: 'Get all books with a specific rating (1-5)',
        usage: 'books_by_rating({ rating: 5 })',
        examples: [
          'show 5-star books in calibre',
          'what are my highest rated books',
          'calibre top rated books',
          'show books rated 4 or higher'
        ]
      },

      // ─── Recent & Discovery ───
      {
        command: 'recent_books',
        description: 'Get the most recently added books in the Calibre library',
        usage: 'recent_books({ limit: 10 })',
        examples: [
          'show recently added books',
          'what was added to calibre recently',
          'newest books in my library',
          'latest ebook additions',
          'recent calibre books'
        ]
      }
    ];

    this.intents = {
      getLibraries: {
        name: 'Calibre Libraries',
        description: 'List available Calibre libraries',
        action: 'get_libraries',
        examples: ['calibre libraries', 'my ebook libraries', 'list calibre libraries']
      },
      libraryStats: {
        name: 'Calibre Library Stats',
        description: 'Get Calibre library statistics and book counts',
        action: 'library_stats',
        examples: ['calibre stats', 'how many books in calibre', 'ebook library stats', 'calibre summary']
      },
      searchBooks: {
        name: 'Search Calibre Books',
        description: 'Search for books in the Calibre library',
        action: 'search_books',
        examples: ['search calibre', 'find books', 'search ebooks', 'look up book in calibre']
      },
      bookDetails: {
        name: 'Calibre Book Details',
        description: 'Get detailed information about a specific book',
        action: 'get_book',
        examples: ['calibre book details', 'book info', 'show book metadata', 'ebook details']
      },
      browseAuthors: {
        name: 'Browse Calibre Authors',
        description: 'Browse or list authors in the Calibre library',
        action: 'browse_category',
        examples: ['calibre authors', 'list authors', 'who wrote books in calibre', 'browse authors']
      },
      booksByAuthor: {
        name: 'Books by Author',
        description: 'Find books by a specific author in Calibre',
        action: 'books_by_author',
        examples: ['books by author', 'show books by', 'calibre author books', 'what did they write']
      },
      booksByTag: {
        name: 'Books by Tag',
        description: 'Find books with a specific tag or genre',
        action: 'books_by_tag',
        examples: ['books tagged', 'genre search calibre', 'calibre tag books', 'find by tag']
      },
      booksBySeries: {
        name: 'Books in Series',
        description: 'Find books in a specific series',
        action: 'books_by_series',
        examples: ['books in series', 'calibre series', 'show series books', 'series list']
      },
      recentBooks: {
        name: 'Recent Calibre Books',
        description: 'Show recently added books in Calibre',
        action: 'recent_books',
        examples: ['recent calibre books', 'new ebooks', 'latest books added', 'recently added to calibre']
      },
      downloadBook: {
        name: 'Download Calibre Book',
        description: 'Get a download link for a book from Calibre',
        action: 'get_download_link',
        examples: ['download book', 'get epub', 'calibre download', 'book download link']
      }
    };
  }

  // ═══════════════════════════════════════
  //  INITIALIZATION
  // ═══════════════════════════════════════

  async initialize() {
    try {
      const credentials = await this.loadCredentials(this.requiredCredentials);
      this.config.url = credentials.url?.replace(/\/+$/, '');
      this.config.username = credentials.username || null;
      this.config.password = credentials.password || null;
    } catch (error) {
      await this._loadStoredCredentials();
    }

    if (!this.config.url) {
      logger.warn('Calibre plugin: URL not configured');
      this.needsConfiguration = true;
      return;
    }

    // Try to auto-detect default library
    try {
      const info = await this._api('get', '/ajax/library-info');
      this.defaultLibrary = info.default_library || Object.keys(info.library_map || {})[0] || null;
      if (this.defaultLibrary) {
        logger.info(`Calibre plugin initialized: ${this.config.url} (library: ${this.defaultLibrary})`);
      } else {
        logger.info(`Calibre plugin initialized: ${this.config.url}`);
      }
    } catch (error) {
      logger.warn(`Calibre plugin: could not fetch library info (${error.message}), will retry on demand`);
    }
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
        if (record.settingsValue.username) {
          try { this.config.username = decrypt(record.settingsValue.username); } catch { this.config.username = record.settingsValue.username; }
        }
        if (record.settingsValue.password) {
          try { this.config.password = decrypt(record.settingsValue.password); } catch { this.config.password = record.settingsValue.password; }
        }
      }
    } catch (error) {
      logger.error('Calibre: Error loading stored credentials:', error.message);
    }
  }

  // ═══════════════════════════════════════
  //  HTTP HELPERS
  // ═══════════════════════════════════════

  async _api(method, path, data = null, params = {}) {
    if (!this.config.url) {
      throw new Error('Calibre URL not configured. Set it in the plugin settings.');
    }

    const url = `${this.config.url}${path}`;
    const auth = this.config.username && this.config.password
      ? { username: this.config.username, password: this.config.password }
      : undefined;

    try {
      const response = await retryOperation(async () => {
        return axios({
          method,
          url,
          data,
          params,
          auth,
          timeout: this.config.timeout
        });
      }, { retries: 2, context: 'calibre-api' });

      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const msg = error.response?.data?.message || error.response?.data || error.message;
      logger.error(`Calibre API error (${method.toUpperCase()} ${path}):`, typeof msg === 'string' ? msg : error.message);
      throw new Error(`Calibre API error${status ? ` (${status})` : ''}: ${typeof msg === 'string' ? msg : error.message}`);
    }
  }

  async _cachedGet(cacheKey, path, params = {}, ttl = null) {
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const data = await this._api('get', path, null, params);
    this.cache.set(cacheKey, data, ttl || 120);
    return data;
  }

  async _getDefaultLibrary() {
    if (this.defaultLibrary) return this.defaultLibrary;

    const info = await this._cachedGet('libraryInfo', '/ajax/library-info', {}, 600);
    this.defaultLibrary = info.default_library || Object.keys(info.library_map || {})[0] || null;
    return this.defaultLibrary;
  }

  _hexEncode(str) {
    return Buffer.from(str, 'utf8').toString('hex');
  }

  // ═══════════════════════════════════════
  //  EXECUTE ROUTER
  // ═══════════════════════════════════════

  async execute(params) {
    const { action, ...data } = params;

    if (!this.config.url) {
      return { success: false, error: 'Calibre URL not configured. Please set it in the plugin settings.' };
    }

    try {
      switch (action) {
        // Library info
        case 'get_libraries':       return await this.getLibraries();
        case 'library_stats':       return await this.getLibraryStats(data);

        // Search
        case 'search_books':        return await this.searchBooks(data);

        // Book details
        case 'get_book':            return await this.getBook(data);
        case 'get_formats':         return await this.getFormats(data);
        case 'get_download_link':   return await this.getDownloadLink(data);

        // Browse
        case 'browse_categories':   return await this.browseCategories(data);
        case 'browse_category':     return await this.browseCategory(data);

        // By field
        case 'books_by_author':     return await this.booksByField(data, 'authors', data.author);
        case 'books_by_tag':        return await this.booksByField(data, 'tags', data.tag);
        case 'books_by_series':     return await this.booksByField(data, 'series', data.series);
        case 'books_by_publisher':  return await this.booksByField(data, 'publisher', data.publisher);
        case 'books_by_rating':     return await this.booksByField(data, 'rating', data.rating);

        // Recent
        case 'recent_books':        return await this.recentBooks(data);

        default:
          return {
            success: false,
            error: `Unknown action: ${action}. Available: ${this.commands.map(c => c.command).join(', ')}`
          };
      }
    } catch (error) {
      logger.error(`Calibre plugin error (${action}):`, error.message);
      return { success: false, error: error.message };
    }
  }

  // ═══════════════════════════════════════
  //  LIBRARY INFO
  // ═══════════════════════════════════════

  async getLibraries() {
    const info = await this._cachedGet('libraryInfo', '/ajax/library-info', {}, 300);
    const map = info.library_map || {};
    const libraries = Object.entries(map).map(([id, name]) => ({
      id,
      name,
      isDefault: id === info.default_library
    }));

    return {
      success: true,
      total: libraries.length,
      defaultLibrary: info.default_library,
      libraries,
      result: libraries.length === 0
        ? 'No libraries found in Calibre.'
        : `Calibre libraries (${libraries.length}):\n${libraries.map(l =>
          `- ${l.name}${l.isDefault ? ' [default]' : ''}`
        ).join('\n')}`
    };
  }

  async getLibraryStats(data) {
    const lib = data.library || await this._getDefaultLibrary();
    if (!lib) return { success: false, error: 'No library found. Specify a library name.' };

    const categories = await this._cachedGet(`categories:${lib}`, `/ajax/categories/${lib}`, {}, 300);

    // Get total book count via a search with empty query
    const searchResult = await this._api('get', `/ajax/search/${lib}`, null, { query: '', num: 0 });
    const totalBooks = searchResult.total_num || 0;

    // Fetch counts from each real category (is_category: true)
    const stats = {};
    for (const cat of categories.filter(c => c.is_category)) {
      const hexName = this._hexEncode(cat.name.toLowerCase());
      try {
        const catData = await this._cachedGet(`cat:${lib}:${cat.name}`, `/ajax/category/${hexName}/${lib}`, { num: 0 }, 300);
        stats[cat.name] = catData.total_num || 0;
      } catch {
        stats[cat.name] = 0;
      }
    }

    return {
      success: true,
      library: lib,
      totalBooks,
      categories: stats,
      result: [
        `Calibre Library: ${lib}`,
        `Total Books: ${totalBooks}`,
        ...Object.entries(stats).map(([name, count]) => `${name}: ${count}`)
      ].join('\n')
    };
  }

  // ═══════════════════════════════════════
  //  SEARCH
  // ═══════════════════════════════════════

  async searchBooks(data) {
    if (!data.query) {
      return { success: false, error: 'Provide a search query' };
    }

    const lib = data.library || await this._getDefaultLibrary();
    if (!lib) return { success: false, error: 'No library found.' };

    const limit = data.limit || 25;
    const offset = data.offset || 0;
    const sort = data.sort || 'title';
    const order = data.order || 'asc';

    const result = await this._api('get', `/ajax/search/${lib}`, null, {
      query: data.query,
      num: limit,
      offset,
      sort,
      sort_order: order
    });

    const bookIds = result.book_ids || [];
    const total = result.total_num || 0;

    if (bookIds.length === 0) {
      return {
        success: true,
        total: 0,
        books: [],
        result: `No books found for "${data.query}" in Calibre.`
      };
    }

    // Fetch metadata for found books
    const books = await this._api('get', `/ajax/books/${lib}`, null, {
      ids: bookIds.join(',')
    });

    const bookList = bookIds.map(id => books[id]).filter(Boolean);

    return {
      success: true,
      total,
      showing: bookList.length,
      books: bookList.map(b => this._formatBookSummary(b)),
      result: `Search results for "${data.query}" (${total} total, showing ${bookList.length}):\n${bookList.map((b, i) =>
        `${i + 1}. ${b.title}${b.authors ? ` — ${b.authors.join(', ')}` : ''}${b.series ? ` [${b.series}${b.series_index ? ` #${b.series_index}` : ''}]` : ''}`
      ).join('\n')}`
    };
  }

  // ═══════════════════════════════════════
  //  BOOK DETAILS
  // ═══════════════════════════════════════

  async getBook(data) {
    if (!data.bookId && data.bookId !== 0) {
      return { success: false, error: 'Provide a bookId' };
    }

    const lib = data.library || await this._getDefaultLibrary();
    if (!lib) return { success: false, error: 'No library found.' };

    const book = await this._api('get', `/ajax/book/${data.bookId}/${lib}`);

    return {
      success: true,
      book: this._formatBookDetails(book),
      result: this._formatBookDetailsText(book)
    };
  }

  async getFormats(data) {
    if (!data.bookId && data.bookId !== 0) {
      return { success: false, error: 'Provide a bookId' };
    }

    const lib = data.library || await this._getDefaultLibrary();
    if (!lib) return { success: false, error: 'No library found.' };

    const book = await this._api('get', `/ajax/book/${data.bookId}/${lib}`);
    const formats = book.formats || [];

    return {
      success: true,
      bookId: data.bookId,
      title: book.title,
      formats,
      result: formats.length === 0
        ? `No file formats available for "${book.title}".`
        : `Available formats for "${book.title}": ${formats.join(', ')}`
    };
  }

  async getDownloadLink(data) {
    if (!data.bookId && data.bookId !== 0) {
      return { success: false, error: 'Provide a bookId' };
    }
    if (!data.format) {
      return { success: false, error: 'Provide a format (e.g., EPUB, PDF, MOBI)' };
    }

    const lib = data.library || await this._getDefaultLibrary();
    if (!lib) return { success: false, error: 'No library found.' };

    const format = data.format.toUpperCase();
    const url = `${this.config.url}/get/${format}/${data.bookId}/${lib}`;

    return {
      success: true,
      bookId: data.bookId,
      format,
      url,
      result: `Download link for book ${data.bookId} (${format}):\n${url}`
    };
  }

  // ═══════════════════════════════════════
  //  BROWSE CATEGORIES
  // ═══════════════════════════════════════

  async browseCategories(data) {
    const lib = data.library || await this._getDefaultLibrary();
    if (!lib) return { success: false, error: 'No library found.' };

    const categories = await this._cachedGet(`categories:${lib}`, `/ajax/categories/${lib}`, {}, 300);

    // Categories only have name/url/icon/is_category — no counts at top level
    return {
      success: true,
      total: categories.length,
      categories: categories.map(c => ({
        name: c.name,
        url: c.url,
        icon: c.icon,
        isCategory: c.is_category || false
      })),
      result: `Calibre categories (${categories.length}):\n${categories.map(c =>
        `- ${c.name}${c.is_category ? '' : ' (virtual)'}`
      ).join('\n')}`
    };
  }

  async browseCategory(data) {
    if (!data.category) {
      return { success: false, error: 'Provide a category name (e.g., authors, tags, series, publisher, rating)' };
    }

    const lib = data.library || await this._getDefaultLibrary();
    if (!lib) return { success: false, error: 'No library found.' };

    const limit = data.limit || 50;
    const offset = data.offset || 0;
    const sort = data.sort || 'name';
    const order = data.order || 'asc';

    const hexName = this._hexEncode(data.category);
    const result = await this._api('get', `/ajax/category/${hexName}/${lib}`, null, {
      num: limit,
      offset,
      sort,
      sort_order: order
    });

    const items = result.items || [];
    const total = result.total_num || items.length;

    return {
      success: true,
      category: data.category,
      total,
      showing: items.length,
      items: items.map(item => ({
        name: item.name,
        count: item.count,
        averageRating: item.average_rating,
        url: item.url
      })),
      result: items.length === 0
        ? `No items found in category "${data.category}".`
        : `${data.category} (${total} total, showing ${items.length}):\n${items.map(item =>
          `- ${item.name} (${item.count} book${item.count !== 1 ? 's' : ''})${item.average_rating ? ` ★${item.average_rating.toFixed(1)}` : ''}`
        ).join('\n')}`
    };
  }

  // ═══════════════════════════════════════
  //  BOOKS BY FIELD
  // ═══════════════════════════════════════

  async booksByField(data, categoryName, value) {
    if (!value) {
      return { success: false, error: `Provide a ${categoryName.replace(/s$/, '')} name` };
    }

    const lib = data.library || await this._getDefaultLibrary();
    if (!lib) return { success: false, error: 'No library found.' };

    const limit = data.limit || 50;
    const offset = data.offset || 0;

    // First find the matching item in the category
    const hexCategory = this._hexEncode(categoryName);
    const categoryResult = await this._api('get', `/ajax/category/${hexCategory}/${lib}`, null, {
      num: 100,
      offset: 0,
      sort: 'name',
      sort_order: 'asc'
    });

    const items = categoryResult.items || [];
    const searchValue = String(value).toLowerCase();

    // Try exact match first, then partial
    let match = items.find(i => i.name.toLowerCase() === searchValue);
    if (!match) {
      match = items.find(i => i.name.toLowerCase().includes(searchValue));
    }

    if (!match) {
      // For ratings, try matching by numeric value
      if (categoryName === 'rating') {
        const ratingValue = parseInt(value);
        match = items.find(i => {
          const itemRating = parseInt(i.name) || 0;
          return itemRating === ratingValue;
        });
      }
    }

    if (!match) {
      return {
        success: true,
        total: 0,
        books: [],
        result: `No ${categoryName.replace(/s$/, '')} matching "${value}" found in Calibre.`,
        suggestion: items.length > 0
          ? `Available: ${items.slice(0, 10).map(i => i.name).join(', ')}${items.length > 10 ? '...' : ''}`
          : undefined
      };
    }

    // Extract numeric item ID from the match's URL
    // URL format: /ajax/books_in/617574686f7273/313334/CalibreLibrary
    const urlParts = match.url.split('/');
    const itemId = urlParts[urlParts.length - 2];
    const booksResult = await this._api('get', `/ajax/books_in/${hexCategory}/${itemId}/${lib}`, null, {
      num: limit,
      offset,
      sort: categoryName === 'series' ? 'series_index' : 'title',
      sort_order: 'asc'
    });

    const bookIds = booksResult.book_ids || [];
    const total = booksResult.total_num || bookIds.length;

    if (bookIds.length === 0) {
      return {
        success: true,
        total: 0,
        books: [],
        result: `No books found for ${categoryName.replace(/s$/, '')} "${match.name}".`
      };
    }

    // Fetch metadata for found books
    const books = await this._api('get', `/ajax/books/${lib}`, null, {
      ids: bookIds.join(',')
    });

    const bookList = bookIds.map(id => books[id]).filter(Boolean);

    return {
      success: true,
      total,
      showing: bookList.length,
      matchedValue: match.name,
      books: bookList.map(b => this._formatBookSummary(b)),
      result: `Books — ${categoryName}: "${match.name}" (${total} total, showing ${bookList.length}):\n${bookList.map((b, i) =>
        `${i + 1}. ${b.title}${b.authors ? ` — ${b.authors.join(', ')}` : ''}${b.series && categoryName !== 'series' ? ` [${b.series}]` : ''}${b.series_index && categoryName === 'series' ? ` (#${b.series_index})` : ''}`
      ).join('\n')}`
    };
  }

  // ═══════════════════════════════════════
  //  RECENT BOOKS
  // ═══════════════════════════════════════

  async recentBooks(data) {
    const lib = data.library || await this._getDefaultLibrary();
    if (!lib) return { success: false, error: 'No library found.' };

    const limit = data.limit || 15;

    // Search with sort by timestamp descending to get recent additions
    const result = await this._api('get', `/ajax/search/${lib}`, null, {
      query: '',
      num: limit,
      offset: 0,
      sort: 'timestamp',
      sort_order: 'desc'
    });

    const bookIds = result.book_ids || [];
    if (bookIds.length === 0) {
      return { success: true, total: 0, books: [], result: 'No books found in Calibre.' };
    }

    const books = await this._api('get', `/ajax/books/${lib}`, null, {
      ids: bookIds.join(',')
    });

    const bookList = bookIds.map(id => books[id]).filter(Boolean);

    return {
      success: true,
      total: result.total_num || bookList.length,
      showing: bookList.length,
      books: bookList.map(b => this._formatBookSummary(b)),
      result: `Recently added books (${bookList.length}):\n${bookList.map((b, i) =>
        `${i + 1}. ${b.title}${b.authors ? ` — ${b.authors.join(', ')}` : ''}${b.timestamp ? ` (${new Date(b.timestamp).toLocaleDateString()})` : ''}`
      ).join('\n')}`
    };
  }

  // ═══════════════════════════════════════
  //  FORMATTING HELPERS
  // ═══════════════════════════════════════

  _formatBookSummary(book) {
    return {
      id: book.application_id || book.id,
      title: book.title,
      authors: book.authors,
      series: book.series,
      seriesIndex: book.series_index,
      tags: book.tags,
      rating: book.rating,
      formats: book.formats,
      timestamp: book.timestamp,
      pubdate: book.pubdate,
      publisher: book.publisher
    };
  }

  _formatBookDetails(book) {
    return {
      id: book.application_id || book.id,
      title: book.title,
      authors: book.authors,
      authorSort: book.author_sort,
      series: book.series,
      seriesIndex: book.series_index,
      tags: book.tags,
      rating: book.rating,
      formats: book.formats,
      publisher: book.publisher,
      pubdate: book.pubdate,
      timestamp: book.timestamp,
      lastModified: book.last_modified,
      languages: book.languages,
      identifiers: book.identifiers,
      comments: book.comments,
      cover: book.cover,
      size: book.size
    };
  }

  _formatBookDetailsText(book) {
    const lines = [
      `${book.title}`,
      book.authors?.length ? `Author(s): ${book.authors.join(', ')}` : '',
      book.series ? `Series: ${book.series}${book.series_index ? ` #${book.series_index}` : ''}` : '',
      book.publisher ? `Publisher: ${book.publisher}` : '',
      book.pubdate ? `Published: ${new Date(book.pubdate).toLocaleDateString()}` : '',
      book.rating ? `Rating: ${'★'.repeat(Math.round(book.rating / 2))}${'☆'.repeat(5 - Math.round(book.rating / 2))} (${book.rating}/10)` : '',
      book.tags?.length ? `Tags: ${book.tags.join(', ')}` : '',
      book.languages?.length ? `Language: ${book.languages.join(', ')}` : '',
      book.formats?.length ? `Formats: ${book.formats.join(', ')}` : '',
      book.identifiers ? `IDs: ${Object.entries(book.identifiers).map(([k, v]) => `${k}: ${v}`).join(', ')}` : '',
      book.comments ? `\nDescription: ${book.comments.replace(/<[^>]+>/g, '').substring(0, 400)}` : ''
    ];
    return lines.filter(Boolean).join('\n');
  }
}
