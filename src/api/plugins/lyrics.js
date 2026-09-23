import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import NodeCache from 'node-cache';

const cache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

export default class LyricsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'lyrics';
    this.version = '1.0.0';
    this.description = 'Look up song lyrics using free APIs (LRCLIB, lyrics.ovh)';

    this.commands = [
      {
        command: 'get',
        description: 'Get the written lyrics text for a song — only when user explicitly asks for LYRICS or WORDS to read',
        usage: 'get({ artist: "Queen", title: "Bohemian Rhapsody" })',
        offerAsService: true,
        examples: [
          'get the lyrics for Bohemian Rhapsody by Queen',
          'show me the lyrics to Stairway to Heaven by Led Zeppelin',
          'lyrics for Blinding Lights by The Weeknd'
        ]
      },
      {
        command: 'search',
        description: 'Search for song lyrics text by keywords or partial lyrics',
        usage: 'search({ query: "never gonna give you up" })',
        offerAsService: true,
        examples: [
          'search for lyrics containing never gonna give you up',
          'what song has these lyrics: is this the real life'
        ]
      },
      {
        command: 'synced',
        description: 'Get time-synced (LRC format) lyrics text for a song',
        usage: 'synced({ artist: "Adele", title: "Hello" })',
        offerAsService: true,
        examples: [
          'get synced lyrics for Hello by Adele',
          'get timed lyrics for Lose Yourself by Eminem'
        ]
      },
      {
        command: 'karaoke',
        description: 'Get karaoke-mode lyrics with word-by-word timing for singing along',
        usage: 'karaoke({ artist: "Queen", title: "Bohemian Rhapsody" })',
        offerAsService: true,
        examples: [
          'start karaoke for Bohemian Rhapsody by Queen',
          'get word-timed lyrics for Don\'t Stop Me Now by Queen'
        ]
      }
    ];

    this.lrclibBase = 'https://lrclib.net/api';
    this.lyricsOvhBase = 'https://api.lyrics.ovh/v1';
  }

  async execute(params) {
    // Support both new-style execute({action, ...}) and old-style execute(action, params)
    let action, data;
    if (typeof params === 'string') {
      action = params;
      data = arguments[1] || {};
    } else {
      ({ action, ...data } = params);
    }

    try {
      switch (action) {
        case 'get':
          return await this.getLyrics(data);
        case 'search':
          return await this.searchLyrics(data);
        case 'synced':
          return await this.getSyncedLyrics(data);
        case 'karaoke':
          return await this.getKaraokeLyrics(data);
        default:
          return { success: false, error: `Unknown action '${action}'. Use: get, search, synced, or karaoke` };
      }
    } catch (error) {
      const msg = error.message || String(error);
      try { this.logger.error(`Lyrics ${action} failed:`, msg); } catch(e) {}
      return { success: false, error: `Lyrics ${action} failed: ${msg}` };
    }
  }

  async getLyrics(data) {
    const { artist, title, query } = data;

    // If we have artist+title, do direct lookup
    if (artist && title) {
      return await this._fetchLyrics(artist, title);
    }

    // If only a query, try search first to resolve artist/title
    if (query) {
      return await this._searchAndFetch(query);
    }

    return {
      success: false,
      error: 'Please provide artist and title, or a search query. Example: "lyrics for Bohemian Rhapsody by Queen"'
    };
  }

  async searchLyrics(data) {
    const { query } = data;

    if (!query) {
      return { success: false, error: 'Search query is required' };
    }

    const cacheKey = `search:${query.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(`${this.lrclibBase}/search`, {
        params: { q: query },
        timeout: 10000,
        headers: { 'User-Agent': 'LANAgent/1.0' }
      });

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        return { success: false, error: `No lyrics found for: "${query}"` };
      }

      const results = response.data.slice(0, 5).map(item => ({
        artist: item.artistName,
        title: item.trackName,
        album: item.albumName,
        duration: item.duration,
        hasPlainLyrics: !!item.plainLyrics,
        hasSyncedLyrics: !!item.syncedLyrics
      }));

      // If there's a strong first match, also include its lyrics
      const best = response.data[0];
      const result = {
        success: true,
        results,
        count: response.data.length
      };

      if (best.plainLyrics) {
        result.bestMatch = {
          artist: best.artistName,
          title: best.trackName,
          album: best.albumName,
          lyrics: best.plainLyrics
        };
        result.result = `Lyrics for "${best.trackName}" by ${best.artistName}:\n\n${best.plainLyrics}`;
      }

      cache.set(cacheKey, result);
      return result;

    } catch (error) {
      this.logger.error('Lyrics search failed:', error.message);
      return { success: false, error: `Search failed: ${error.message}` };
    }
  }

  async getSyncedLyrics(data) {
    const { artist, title, query } = data;

    if (!artist || !title) {
      if (query) {
        // Try to find via search
        const searchResult = await this._lrclibSearch(query);
        if (searchResult && searchResult.syncedLyrics) {
          return {
            success: true,
            artist: searchResult.artistName,
            title: searchResult.trackName,
            album: searchResult.albumName,
            syncedLyrics: searchResult.syncedLyrics,
            result: `Synced lyrics for "${searchResult.trackName}" by ${searchResult.artistName}:\n\n${searchResult.syncedLyrics}`
          };
        }
        return { success: false, error: `No synced lyrics found for: "${query}"` };
      }
      return { success: false, error: 'Please provide artist and title for synced lyrics' };
    }

    const cacheKey = `synced:${artist.toLowerCase()}:${title.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(`${this.lrclibBase}/get`, {
        params: { artist_name: artist, track_name: title },
        timeout: 10000,
        headers: { 'User-Agent': 'LANAgent/1.0' }
      });

      if (!response.data?.syncedLyrics) {
        return {
          success: false,
          error: `No synced lyrics available for "${title}" by ${artist}. Plain lyrics may be available — try the "get" command.`
        };
      }

      const result = {
        success: true,
        artist: response.data.artistName,
        title: response.data.trackName,
        album: response.data.albumName,
        syncedLyrics: response.data.syncedLyrics,
        result: `Synced lyrics for "${response.data.trackName}" by ${response.data.artistName}:\n\n${response.data.syncedLyrics}`
      };

      cache.set(cacheKey, result);
      return result;

    } catch (error) {
      if (error.response?.status === 404) {
        return { success: false, error: `No synced lyrics found for "${title}" by ${artist}` };
      }
      this.logger.error('Synced lyrics fetch failed:', error.message);
      return { success: false, error: `Failed to fetch synced lyrics: ${error.message}` };
    }
  }

  /**
   * Get karaoke-mode lyrics with word-by-word timing
   */
  async getKaraokeLyrics(data) {
    const { artist, title, query } = data;

    if (!artist || !title) {
      if (query) {
        // Try to find via search
        const searchResult = await this._lrclibSearch(query);
        if (searchResult && searchResult.syncedLyrics) {
          const karaokeData = this._parseLrcToKaraoke(searchResult.syncedLyrics);
          return {
            success: true,
            artist: searchResult.artistName,
            title: searchResult.trackName,
            album: searchResult.albumName,
            karaoke: karaokeData,
            result: `Karaoke lyrics for "${searchResult.trackName}" by ${searchResult.artistName}`
          };
        }
        return { success: false, error: `No synced lyrics found for: "${query}"` };
      }
      return { success: false, error: 'Please provide artist and title for karaoke lyrics' };
    }

    const cacheKey = `karaoke:${artist.toLowerCase()}:${title.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(`${this.lrclibBase}/get`, {
        params: { artist_name: artist, track_name: title },
        timeout: 10000,
        headers: { 'User-Agent': 'LANAgent/1.0' }
      });

      if (!response.data?.syncedLyrics) {
        return {
          success: false,
          error: `No synced lyrics available for "${title}" by ${artist}. Karaoke mode requires time-synced lyrics.`
        };
      }

      const karaokeData = this._parseLrcToKaraoke(response.data.syncedLyrics);
      
      const result = {
        success: true,
        artist: response.data.artistName,
        title: response.data.trackName,
        album: response.data.albumName,
        karaoke: karaokeData,
        result: `Karaoke lyrics for "${response.data.trackName}" by ${response.data.artistName}`
      };

      cache.set(cacheKey, result);
      return result;

    } catch (error) {
      if (error.response?.status === 404) {
        return { success: false, error: `No synced lyrics found for "${title}" by ${artist}` };
      }
      this.logger.error('Karaoke lyrics fetch failed:', error.message);
      return { success: false, error: `Failed to fetch karaoke lyrics: ${error.message}` };
    }
  }

  /**
   * Parse LRC lyrics into word-by-word karaoke timing.
   *
   * The first version gave every line a hardcoded `totalDuration = 1000` and split that
   * across its words, so a four-second line finished highlighting after one second and
   * sat idle for three. The timings were invented, which for a feature whose entire
   * purpose is word timing meant it never actually worked.
   *
   * A line's real duration is the gap to the NEXT timestamp — that is what LRC encodes,
   * and it was already being parsed and then discarded.
   *
   * Two sources of word timing, and the result says which was used:
   *   - Enhanced LRC carries per-word tags, `[00:12.00]<00:12.00>Some <00:12.50>words`.
   *     Where present those are exact and are used as-is.
   *   - Plain LRC has none, so words are apportioned across the line by character
   *     length. That is an estimate and is labelled one; longer words take longer to
   *     sing than short ones, so this beats an even split, but it is not measurement.
   */
  _parseLrcToKaraoke(lrcContent) {
    const LINE_TS = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const WORD_TS = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;

    const toMs = (min, sec, frac) => {
      // LRC fractions are usually centiseconds but milliseconds appear in the wild;
      // scale by the digit count rather than assuming two.
      let fracMs = 0;
      if (frac !== undefined && frac !== null && frac !== '') {
        fracMs = frac.length === 3 ? parseInt(frac, 10) : parseInt(frac, 10) * (frac.length === 1 ? 100 : 10);
      }
      return (parseInt(min, 10) * 60 + parseInt(sec, 10)) * 1000 + fracMs;
    };

    // Pass 1 — every (timestamp, text) pair. A line may carry several timestamps when
    // the same words recur, e.g. a chorus; the original kept only the first and dropped
    // every later repeat.
    const entries = [];
    for (const line of lrcContent.split('\n')) {
      if (!line.trim()) continue;

      LINE_TS.lastIndex = 0;
      const stamps = [];
      let match, textFrom = 0;
      while ((match = LINE_TS.exec(line)) !== null) {
        stamps.push(toMs(match[1], match[2], match[3]));
        textFrom = match.index + match[0].length;
      }
      if (stamps.length === 0) continue;

      const raw = line.substring(textFrom).trim();
      const plain = raw.replace(WORD_TS, '').replace(/\s+/g, ' ').trim();
      if (!plain || plain === '//') continue;

      for (const start of stamps) entries.push({ start, raw, text: plain });
    }

    entries.sort((a, b) => a.start - b.start);

    // Pass 2 — a line runs until the next one begins.
    const DEFAULT_LAST_LINE_MS = 3000;
    return entries.map((entry, i) => {
      const next = entries[i + 1];
      const duration = next ? Math.max(0, next.start - entry.start) : DEFAULT_LAST_LINE_MS;

      // Enhanced LRC: exact per-word tags.
      WORD_TS.lastIndex = 0;
      const tagged = [];
      let m, cursor = 0;
      while ((m = WORD_TS.exec(entry.raw)) !== null) {
        if (tagged.length > 0) {
          tagged[tagged.length - 1].text = entry.raw.slice(cursor, m.index).trim();
        }
        tagged.push({ start: toMs(m[1], m[2], m[3]), text: '' });
        cursor = m.index + m[0].length;
      }
      if (tagged.length > 0) {
        tagged[tagged.length - 1].text = entry.raw.slice(cursor).trim();
        const words = tagged
          .filter(t => t.text)
          .map((t, idx, arr) => ({
            word: t.text,
            start: t.start,
            end: idx + 1 < arr.length ? arr[idx + 1].start : entry.start + duration
          }));
        if (words.length > 0) {
          return { text: entry.text, start: entry.start, end: entry.start + duration,
                   timingSource: 'lrc_word_tags', words };
        }
      }

      // Plain LRC: apportion the real line duration by word length.
      const words = entry.text.split(/\s+/).filter(Boolean);
      const totalChars = words.reduce((sum, w) => sum + w.length, 0) || 1;
      let cursorMs = entry.start;
      const timed = words.map(word => {
        const share = (word.length / totalChars) * duration;
        const start = Math.round(cursorMs);
        cursorMs += share;
        return { word, start, end: Math.round(cursorMs) };
      });

      return { text: entry.text, start: entry.start, end: entry.start + duration,
               timingSource: 'estimated_from_line_duration', words: timed };
    }).filter(line => line.words.length > 0);
  }

  async _fetchLyrics(artist, title) {
    const cacheKey = `lyrics:${artist.toLowerCase()}:${title.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // Try LRCLIB first (best quality, free, no API key)
    try {
      const lrcResult = await axios.get(`${this.lrclibBase}/get`, {
        params: { artist_name: artist, track_name: title },
        timeout: 10000,
        headers: { 'User-Agent': 'LANAgent/1.0' }
      });

      if (lrcResult.data?.plainLyrics) {
        const result = {
          success: true,
          source: 'lrclib',
          artist: lrcResult.data.artistName,
          title: lrcResult.data.trackName,
          album: lrcResult.data.albumName,
          lyrics: lrcResult.data.plainLyrics,
          hasSyncedLyrics: !!lrcResult.data.syncedLyrics,
          result: `Lyrics for "${lrcResult.data.trackName}" by ${lrcResult.data.artistName}:\n\n${lrcResult.data.plainLyrics}`
        };
        cache.set(cacheKey, result);
        return result;
      }
    } catch (error) {
      if (error.response?.status !== 404) {
        this.logger.warn('LRCLIB fetch failed, trying fallback:', error.message);
      }
    }

    // Fallback to lyrics.ovh
    try {
      const ovhResult = await axios.get(
        `${this.lyricsOvhBase}/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
        { timeout: 10000 }
      );

      if (ovhResult.data?.lyrics) {
        const lyrics = ovhResult.data.lyrics.trim();
        const result = {
          success: true,
          source: 'lyrics.ovh',
          artist,
          title,
          lyrics,
          hasSyncedLyrics: false,
          result: `Lyrics for "${title}" by ${artist}:\n\n${lyrics}`
        };
        cache.set(cacheKey, result);
        return result;
      }
    } catch (error) {
      if (error.response?.status !== 404) {
        this.logger.warn('lyrics.ovh fetch failed:', error.message);
      }
    }

    // Both sources failed — try LRCLIB search as last resort
    const searchResult = await this._lrclibSearch(`${artist} ${title}`);
    if (searchResult?.plainLyrics) {
      const result = {
        success: true,
        source: 'lrclib-search',
        artist: searchResult.artistName,
        title: searchResult.trackName,
        album: searchResult.albumName,
        lyrics: searchResult.plainLyrics,
        hasSyncedLyrics: !!searchResult.syncedLyrics,
        result: `Lyrics for "${searchResult.trackName}" by ${searchResult.artistName}:\n\n${searchResult.plainLyrics}`
      };
      cache.set(cacheKey, result);
      return result;
    }

    return {
      success: false,
      error: `Could not find lyrics for "${title}" by ${artist}. Try searching with different spelling or a search query.`
    };
  }

  async _searchAndFetch(query) {
    const cacheKey = `queryfetch:${query.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const searchResult = await this._lrclibSearch(query);
    if (searchResult?.plainLyrics) {
      const result = {
        success: true,
        source: 'lrclib-search',
        artist: searchResult.artistName,
        title: searchResult.trackName,
        album: searchResult.albumName,
        lyrics: searchResult.plainLyrics,
        hasSyncedLyrics: !!searchResult.syncedLyrics,
        result: `Lyrics for "${searchResult.trackName}" by ${searchResult.artistName}:\n\n${searchResult.plainLyrics}`
      };
      cache.set(cacheKey, result);
      return result;
    }

    return { success: false, error: `No lyrics found for: "${query}"` };
  }

  async _lrclibSearch(query) {
    // Try twice with increasing timeout
    for (const timeout of [8000, 15000]) {
      try {
        const response = await axios.get(`${this.lrclibBase}/search`, {
          params: { q: query },
          timeout,
          headers: { 'User-Agent': 'LANAgent/1.0' }
        });

        if (Array.isArray(response.data) && response.data.length > 0) {
          return response.data.find(item => item.plainLyrics) || response.data[0];
        }
        return null; // Empty results, don't retry
      } catch (error) {
        // Rate limited or server error — retry with longer timeout
        if (error.response?.status === 429 || error.response?.status >= 500) {
          this.logger.warn(`LRCLIB search ${error.response?.status}, retrying...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        this.logger.warn('LRCLIB search failed:', error.message);
        return null;
      }
    }
    return null;
  }
}
