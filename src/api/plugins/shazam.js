import { BasePlugin } from '../core/basePlugin.js';
import fs from 'fs';
import NodeCache from 'node-cache';

export default class ShazamPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'shazam';
    this.version = '1.0.0';
    this.description = 'Song recognition and music search using Shazam';

    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

    this.commands = [
      {
        command: 'identify',
        description: 'Identify a song from an audio file or voice message',
        usage: 'identify({ filePath: "/tmp/audio.ogg" })',
        examples: [
          'what song is this',
          'identify this song',
          'shazam',
          'recognize this song',
          'what music is playing',
          'name that song',
          'what is this song called'
        ]
      },
      {
        command: 'search',
        description: 'Search for a song by name or lyrics',
        usage: 'search({ query: "bohemian rhapsody" })',
        examples: [
          'search for song bohemian rhapsody',
          'find song never gonna give you up',
          'look up song by lyrics is this the real life',
          'search music despacito',
          'find a song called stairway to heaven'
        ]
      },
      {
        command: 'recommend',
        description: 'Get music recommendations based on a song',
        usage: 'recommend({ songId: "track-id" })'
      },
      {
        command: 'getSongDetails',
        description: 'Get detailed metadata for a song by its Shazam track ID',
        usage: 'getSongDetails({ songId: "track-id" })',
        examples: [
          'get song details for track 123456',
          'song info for shazam id 123456',
          'details about this track'
        ]
      },
      {
        command: 'getLyrics',
        description: 'Fetch lyrics for an identified song (resolves songId via Shazam, then queries lyrics.ovh)',
        usage: 'getLyrics({ songId: "track-id" })',
        examples: [
          'get lyrics for track 123456',
          'lyrics for shazam id 123456',
          'show lyrics for this song'
        ]
      }
    ];
  }

  async execute(params) {
    const { action, ...data } = params;

    switch (action) {
      case 'identify':
        return await this.identifySong(data);
      case 'search':
        return await this.searchMusic(data);
      case 'recommend':
        return await this.getRecommendations(data);
      case 'getSongDetails':
        return await this.getSongDetails(data);
      case 'getLyrics':
        return await this.getLyrics(data);
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }

  async identifySong(data) {
    const { filePath } = data;

    // No audio file provided — prompt the user to send one
    if (!filePath) {
      return {
        success: true,
        type: 'text',
        result: '🎵 Send me a voice message or audio file and I\'ll identify the song!',
        metadata: { setOperation: 'shazam' }
      };
    }

    try {
      this.logger.info(`Identifying song from file: ${filePath}`);

      const { Shazam } = await import('node-shazam');
      const shazam = new Shazam();
      const result = await shazam.recognise(filePath, 'en-US');

      if (!result || !result.track) {
        return {
          success: true,
          type: 'text',
          result: '🎵 Could not identify the song. Try sending a clearer audio clip with the music more prominent.'
        };
      }

      const track = result.track;
      const title = track.title || 'Unknown';
      const artist = track.subtitle || 'Unknown';
      const album = track.sections?.find(s => s.type === 'SONG')?.metadata?.find(m => m.title === 'Album')?.text || '';
      const coverUrl = track.images?.coverart || '';
      const shazamUrl = track.url || track.share?.href || '';
      const songId = track.key || '';

      let response = `🎵 *Song Identified!*\n\n`;
      response += `*Title:* ${title}\n`;
      response += `*Artist:* ${artist}\n`;
      if (album) response += `*Album:* ${album}\n`;
      if (shazamUrl) response += `\n🔗 ${shazamUrl}`;

      this.logger.info(`Song identified: ${title} by ${artist}`);

      return {
        success: true,
        type: 'text',
        result: response,
        metadata: {
          title,
          artist,
          album,
          coverUrl,
          shazamUrl,
          songId
        }
      };
    } catch (error) {
      this.logger.error('Shazam identification failed:', error);
      return {
        success: false,
        error: `Song identification failed: ${error.message}`
      };
    } finally {
      // Clean up temp file if it exists
      if (filePath) {
        try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
      }
    }
  }

  async searchMusic(data) {
    const { query, input } = data;
    const searchQuery = query || input;

    if (!searchQuery) {
      // Try AI extraction from raw text
      if (data.rawInput) {
        try {
          const aiResult = await this.processWithAI(
            `Extract the song name or search query from this text. Return ONLY the search query, nothing else:\n"${data.rawInput}"`
          );
          const extracted = aiResult?.content?.trim();
          if (extracted) {
            return await this.searchMusic({ query: extracted });
          }
        } catch (e) {
          this.logger.warn('AI extraction failed for search query:', e.message);
        }
      }
      return { success: false, error: 'Please provide a song name or lyrics to search for.' };
    }

    try {
      this.logger.info(`Searching Shazam for: ${searchQuery}`);

      const { Shazam } = await import('node-shazam');
      const shazam = new Shazam();
      let results;
      try {
        results = await shazam.search_music('en-US', 'US', searchQuery, '5', '0');
      } catch (searchErr) {
        // Shazam search API can sometimes return non-JSON responses
        this.logger.warn('Shazam search API error, trying term search:', searchErr.message);
        // Fall back to term-based search if available
        try {
          results = await shazam.search_music('en-US', 'GB', searchQuery, '5', '0');
        } catch (fallbackErr) {
          return {
            success: false,
            error: `Shazam search is currently unavailable. Try identifying a song by sending audio instead.`
          };
        }
      }

      const tracks = results?.tracks?.hits || [];
      if (tracks.length === 0) {
        return {
          success: true,
          type: 'text',
          result: `🔍 No results found for "${searchQuery}". Try sending an audio clip instead for identification.`
        };
      }

      let response = `🔍 *Search Results for "${searchQuery}":*\n\n`;
      tracks.forEach((hit, i) => {
        const track = hit.track || hit;
        const title = track.title || track.heading?.title || 'Unknown';
        const artist = track.subtitle || track.heading?.subtitle || 'Unknown';
        const url = track.url || track.share?.href || '';
        response += `${i + 1}. *${title}* — ${artist}`;
        if (url) response += ` ([link](${url}))`;
        response += '\n';
      });

      return {
        success: true,
        type: 'text',
        result: response
      };
    } catch (error) {
      this.logger.error('Shazam search failed:', error);
      return {
        success: false,
        error: `Search failed: ${error.message}`
      };
    }
  }

  async getRecommendations(data) {
    const { songId } = data;

    if (!songId) {
      return { success: false, error: 'Please provide a song ID for recommendations.' };
    }

    const cacheKey = `recommendations_${songId}`;
    const cachedResult = this.cache.get(cacheKey);
    if (cachedResult) {
      return {
        success: true,
        type: 'text',
        result: cachedResult,
        metadata: { fromCache: true }
      };
    }

    try {
      this.logger.info(`Fetching recommendations for song ID: ${songId}`);

      const { Shazam } = await import('node-shazam');
      const shazam = new Shazam();
      const results = await shazam.related_songs('en-US', 'US', songId, '0', '5');

      const tracks = results?.tracks || [];
      if (tracks.length === 0) {
        return {
          success: true,
          type: 'text',
          result: 'No recommendations found for the provided song.'
        };
      }

      let response = `🎶 *Recommended Songs:*\n\n`;
      tracks.forEach((track, i) => {
        const title = track.title || 'Unknown';
        const artist = track.subtitle || 'Unknown';
        const url = track.url || track.share?.href || '';
        response += `${i + 1}. *${title}* — ${artist}`;
        if (url) response += ` ([link](${url}))`;
        response += '\n';
      });

      this.cache.set(cacheKey, response);

      return {
        success: true,
        type: 'text',
        result: response
      };
    } catch (error) {
      this.logger.error('Failed to fetch recommendations:', error);
      return {
        success: false,
        error: `Failed to get recommendations: ${error.message}`
      };
    }
  }

  async getSongDetails(data) {
    const { songId } = data;

    if (!songId) {
      return { success: false, error: 'Please provide a song ID to look up details.' };
    }

    const cacheKey = `song_details_${songId}`;
    const cachedResult = this.cache.get(cacheKey);
    if (cachedResult) {
      return { success: true, type: 'text', result: cachedResult.text, metadata: { ...cachedResult.metadata, fromCache: true } };
    }

    try {
      this.logger.info(`Fetching song details for track ID: ${songId}`);

      const { Shazam } = await import('node-shazam');
      const shazam = new Shazam();
      const raw = await shazam.track_info('en-US', 'US', songId);

      // track_info may return the track directly or nested under a `track` property
      const track = raw?.track || raw;

      if (!track || (!track.title && !track.key)) {
        return {
          success: true,
          type: 'text',
          result: `No details found for track ID: ${songId}`
        };
      }

      const title = track.title || 'Unknown';
      const artist = track.subtitle || 'Unknown';
      const genre = track.genres?.primary || track.sections?.find(s => s.type === 'SONG')?.metadata?.find(m => m.title === 'Genre')?.text || '';
      const album = track.sections?.find(s => s.type === 'SONG')?.metadata?.find(m => m.title === 'Album')?.text || '';
      const coverUrl = track.images?.coverart || '';
      const shazamUrl = track.url || track.share?.href || '';

      let response = `🎵 *Song Details*\n\n`;
      response += `*Title:* ${title}\n`;
      response += `*Artist:* ${artist}\n`;
      if (album) response += `*Album:* ${album}\n`;
      if (genre) response += `*Genre:* ${genre}\n`;
      if (coverUrl) response += `*Cover:* ${coverUrl}\n`;
      if (shazamUrl) response += `\n🔗 ${shazamUrl}`;

      const metadata = { title, artist, genre, album, coverUrl, shazamUrl, songId };
      this.cache.set(cacheKey, { text: response, metadata });

      this.logger.info(`Song details fetched: ${title} by ${artist}`);

      return { success: true, type: 'text', result: response, metadata };
    } catch (error) {
      this.logger.error('Failed to fetch song details:', error);
      return {
        success: false,
        error: `Failed to get song details: ${error.message}`
      };
    }
  }

  /**
   * Fetch lyrics for an identified song.
   *
   * Resolves the Shazam track via track_info to get { title, subtitle (artist) },
   * then queries lyrics.ovh — a free public lyrics API whose endpoint is
   * `/v1/{artist}/{title}`, not `/v1/{songId}`. Caches by songId so repeat
   * lookups don't re-hit either Shazam or lyrics.ovh.
   */
  async getLyrics(data) {
    const { songId, artist: artistArg, title: titleArg } = data;

    if (!songId && !(artistArg && titleArg)) {
      return { success: false, error: 'Provide a Shazam songId, or both artist and title.' };
    }

    const cacheKey = songId ? `lyrics_id_${songId}` : `lyrics_kv_${artistArg}_${titleArg}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, type: 'text', result: cached.text, metadata: { ...cached.metadata, fromCache: true } };
    }

    let artist = artistArg;
    let title = titleArg;

    // If only songId provided, resolve artist+title via Shazam track_info
    if (!artist || !title) {
      try {
        const { Shazam } = await import('node-shazam');
        const shazam = new Shazam();
        const raw = await shazam.track_info('en-US', 'US', songId);
        const track = raw?.track || raw;
        if (!track || (!track.title && !track.subtitle)) {
          return { success: false, error: `No track found for songId ${songId}` };
        }
        title = track.title || title;
        artist = track.subtitle || artist;
      } catch (err) {
        this.logger.error(`Failed to resolve track ${songId} for lyrics:`, err);
        return { success: false, error: `Could not resolve track ${songId}: ${err.message}` };
      }
    }

    if (!artist || !title) {
      return { success: false, error: 'Could not determine artist and title for this song.' };
    }

    try {
      this.logger.info(`Fetching lyrics: ${artist} — ${title}`);
      const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
      const response = await fetch(url);

      if (response.status === 404) {
        return {
          success: true,
          type: 'text',
          result: `No lyrics found on lyrics.ovh for ${artist} — ${title}.`,
          metadata: { artist, title, songId, found: false }
        };
      }
      if (!response.ok) {
        return { success: false, error: `lyrics.ovh returned HTTP ${response.status}` };
      }

      const body = await response.json();
      const lyrics = (body?.lyrics || '').trim();
      if (!lyrics) {
        return {
          success: true,
          type: 'text',
          result: `No lyrics found on lyrics.ovh for ${artist} — ${title}.`,
          metadata: { artist, title, songId, found: false }
        };
      }

      const text = `🎶 *Lyrics — ${title} by ${artist}*\n\n${lyrics}`;
      const metadata = { artist, title, songId, found: true, source: 'lyrics.ovh' };
      this.cache.set(cacheKey, { text, metadata });
      return { success: true, type: 'text', result: text, metadata };
    } catch (error) {
      this.logger.error('Failed to fetch lyrics:', error);
      return { success: false, error: `Failed to get lyrics: ${error.message}` };
    }
  }
}
