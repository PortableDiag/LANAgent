/**
 * Anime Plugin
 *
 * Provides anime discovery, search, and information services
 * using the Jikan API (unofficial MyAnimeList API) - no API key required.
 *
 * API Documentation: https://docs.api.jikan.moe/
 *
 * Note: Uses Jikan API v4 which is free and doesn't require authentication
 */

import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import axios from 'axios';
import NodeCache from 'node-cache';

export default class AnimePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'anime';
    this.version = '1.0.0';
    this.description = 'Anime discovery, search, and information using MyAnimeList data';
    this.category = 'entertainment';

    // Commands array for vector intent detection
    this.commands = [
      {
        command: 'search',
        description: 'Search for anime by title',
        usage: 'search({ query: "Naruto", limit: 10 })',
        examples: [
          'search for anime called Naruto',
          'find anime titled Attack on Titan',
          'look up One Piece anime',
          'search anime Death Note',
          'find anime similar to Demon Slayer'
        ]
      },
      {
        command: 'details',
        description: 'Get detailed information about a specific anime by its MyAnimeList ID',
        usage: 'details({ id: 21 })',
        examples: [
          'get details for anime ID 21',
          'show me information about anime 1735',
          'what is anime with ID 5114',
          'tell me about anime number 16498',
          'details of MAL anime 38000'
        ]
      },
      {
        command: 'top',
        description: 'Get top-rated anime list by category',
        usage: 'top({ type: "tv", filter: "airing", limit: 10 })',
        examples: [
          'show me top anime',
          'what are the best rated anime',
          'top 10 anime of all time',
          'most popular anime right now',
          'best anime series currently airing'
        ]
      },
      {
        command: 'seasonal',
        description: 'Get anime from a specific season',
        usage: 'seasonal({ year: 2024, season: "winter", limit: 10 })',
        examples: [
          'what anime is airing this season',
          'show me winter 2024 anime',
          'anime from fall 2023 season',
          'current season anime list',
          'new anime this season'
        ]
      },
      {
        command: 'recommendations',
        description: 'Get anime recommendations based on an anime ID',
        usage: 'recommendations({ id: 21 })',
        examples: [
          'recommend anime like Naruto',
          'what should I watch after Attack on Titan',
          'similar anime to One Piece',
          'anime recommendations for ID 21',
          'if I like Death Note what else would I enjoy'
        ]
      },
      {
        command: 'random',
        description: 'Get a random anime suggestion',
        usage: 'random()',
        examples: [
          'give me a random anime',
          'suggest a random anime to watch',
          'pick an anime for me',
          'random anime recommendation',
          'surprise me with an anime'
        ]
      }
    ];

    // Plugin configuration
    this.config = {
      baseUrl: 'https://api.jikan.moe/v4',
      rateLimitMs: 1000  // Jikan has rate limits, 1 req/sec for free tier
    };

    // Cache to reduce API calls (Jikan has rate limits)
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min cache

    this.initialized = false;
    this.lastRequestTime = 0;
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      // Load cached configuration
      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        Object.assign(this.config, savedConfig);
        this.logger.info('Loaded cached configuration');
      }

      // Save configuration to cache
      await PluginSettings.setCached(this.name, 'config', this.config);

      this.initialized = true;
      this.logger.info(`${this.name} plugin initialized successfully`);
    } catch (error) {
      if (error && error.message && (error.message.includes('Missing required credentials') || /API[_-]?KEY.*(required|missing|not configured)/i.test(error.message) || /environment variable .* (required|not set)/i.test(error.message) || /credentials? (not configured|missing|required)/i.test(error.message))) {
        this.logger.warn(`Failed to initialize ${this.name} plugin: ${error.message}`);
      } else {
        this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
      }
      throw error;
    }
  }

  /**
   * Rate limit helper - Jikan API has strict rate limits
   */
  async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.config.rateLimitMs) {
      await new Promise(resolve => setTimeout(resolve, this.config.rateLimitMs - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  async execute(params) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: this.commands.map(c => c.command)
      }
    });

    // Handle AI parameter extraction for vector-matched intents
    if (params.needsParameterExtraction && this.agent?.providerManager) {
      const extracted = await this.extractParameters(params.originalInput || params.input, action);
      Object.assign(data, extracted);
    }

    try {
      switch (action) {
        case 'search':
          return await this.searchAnime(data);
        case 'details':
          return await this.getAnimeDetails(data);
        case 'top':
          return await this.getTopAnime(data);
        case 'seasonal':
          return await this.getSeasonalAnime(data);
        case 'recommendations':
          return await this.getRecommendations(data);
        case 'random':
          return await this.getRandomAnime();
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`${action} failed:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async extractParameters(input, action) {
    const prompt = `Extract parameters from: "${input}"
    For anime plugin action: ${action}

    Actions and their parameters:
    - search: { query: "anime title to search" }
    - details: { id: number (MyAnimeList ID) }
    - top: { type: "tv|movie|ova|special|ona", filter: "airing|upcoming|bypopularity|favorite", limit: number }
    - seasonal: { year: number, season: "winter|spring|summer|fall", limit: number }
    - recommendations: { id: number (MAL ID of anime to get recommendations for) }
    - random: {} (no parameters needed)

    For the current season, use year ${new Date().getFullYear()} and determine season from current month.

    Return JSON with the appropriate parameters.`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });

    const parsed = safeJsonParse(response.content, {});
    if (!parsed || Object.keys(parsed).length === 0) {
      this.logger.warn('Failed to parse AI parameters from response');
    }
    return parsed;
  }

  /**
   * Search for anime by title
   */
  async searchAnime({ query, limit = 10 }) {
    if (!query) {
      return { success: false, error: 'Search query is required' };
    }

    const cacheKey = `search:${query.toLowerCase()}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, cached: true };
    }

    await this.rateLimit();

    try {
      const response = await retryOperation(
        () => axios.get(`${this.config.baseUrl}/anime`, {
          params: {
            q: query,
            limit: Math.min(limit, 25),
            sfw: true
          }
        }),
        { retries: 3, context: 'Jikan Anime Search' }
      );

      const results = response.data.data.map(anime => this.formatAnimeBasic(anime));

      const data = {
        query,
        count: results.length,
        results
      };

      this.cache.set(cacheKey, data);
      return { success: true, data };
    } catch (error) {
      this.logger.error('Anime search failed:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get detailed anime information
   */
  async getAnimeDetails({ id }) {
    if (!id) {
      return { success: false, error: 'Anime ID is required' };
    }

    const cacheKey = `details:${id}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, cached: true };
    }

    await this.rateLimit();

    try {
      const response = await retryOperation(
        () => axios.get(`${this.config.baseUrl}/anime/${id}/full`),
        { retries: 3, context: 'Jikan Anime Details' }
      );

      const anime = response.data.data;
      const data = {
        id: anime.mal_id,
        title: anime.title,
        titleEnglish: anime.title_english,
        titleJapanese: anime.title_japanese,
        type: anime.type,
        episodes: anime.episodes,
        status: anime.status,
        airing: anime.airing,
        aired: anime.aired?.string,
        duration: anime.duration,
        rating: anime.rating,
        score: anime.score,
        scoredBy: anime.scored_by,
        rank: anime.rank,
        popularity: anime.popularity,
        synopsis: anime.synopsis,
        background: anime.background,
        season: anime.season,
        year: anime.year,
        studios: anime.studios?.map(s => s.name) || [],
        genres: anime.genres?.map(g => g.name) || [],
        themes: anime.themes?.map(t => t.name) || [],
        demographics: anime.demographics?.map(d => d.name) || [],
        imageUrl: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url,
        trailerUrl: anime.trailer?.url,
        url: anime.url
      };

      this.cache.set(cacheKey, data);
      return { success: true, data };
    } catch (error) {
      this.logger.error('Anime details failed:', error);
      if (error.response?.status === 404) {
        return { success: false, error: `Anime with ID ${id} not found` };
      }
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get top anime list
   */
  async getTopAnime({ type = 'tv', filter = '', limit = 10 }) {
    const cacheKey = `top:${type}:${filter}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, cached: true };
    }

    await this.rateLimit();

    try {
      const params = {
        type,
        limit: Math.min(limit, 25),
        sfw: true
      };

      if (filter) {
        params.filter = filter;
      }

      const response = await retryOperation(
        () => axios.get(`${this.config.baseUrl}/top/anime`, { params }),
        { retries: 3, context: 'Jikan Top Anime' }
      );

      const results = response.data.data.map(anime => this.formatAnimeBasic(anime));

      const data = {
        type,
        filter: filter || 'default',
        count: results.length,
        results
      };

      this.cache.set(cacheKey, data);
      return { success: true, data };
    } catch (error) {
      this.logger.error('Top anime failed:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get seasonal anime
   */
  async getSeasonalAnime({ year, season, limit = 10 }) {
    // Default to current season if not specified
    const now = new Date();
    const currentYear = year || now.getFullYear();
    const currentSeason = season || this.getCurrentSeason();

    const cacheKey = `seasonal:${currentYear}:${currentSeason}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, cached: true };
    }

    await this.rateLimit();

    try {
      const response = await retryOperation(
        () => axios.get(`${this.config.baseUrl}/seasons/${currentYear}/${currentSeason}`, {
          params: {
            limit: Math.min(limit, 25),
            sfw: true
          }
        }),
        { retries: 3, context: 'Jikan Seasonal Anime' }
      );

      const results = response.data.data.map(anime => this.formatAnimeBasic(anime));

      const data = {
        year: currentYear,
        season: currentSeason,
        count: results.length,
        results
      };

      this.cache.set(cacheKey, data);
      return { success: true, data };
    } catch (error) {
      this.logger.error('Seasonal anime failed:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get anime recommendations based on an anime
   */
  async getRecommendations({ id }) {
    if (!id) {
      return { success: false, error: 'Anime ID is required for recommendations' };
    }

    const cacheKey = `recommendations:${id}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, cached: true };
    }

    await this.rateLimit();

    try {
      const response = await retryOperation(
        () => axios.get(`${this.config.baseUrl}/anime/${id}/recommendations`),
        { retries: 3, context: 'Jikan Anime Recommendations' }
      );

      const recommendations = response.data.data.slice(0, 10).map(rec => ({
        id: rec.entry.mal_id,
        title: rec.entry.title,
        imageUrl: rec.entry.images?.jpg?.image_url,
        url: rec.entry.url,
        votes: rec.votes
      }));

      const data = {
        basedOn: id,
        count: recommendations.length,
        recommendations
      };

      this.cache.set(cacheKey, data);
      return { success: true, data };
    } catch (error) {
      this.logger.error('Recommendations failed:', error);
      if (error.response?.status === 404) {
        return { success: false, error: `Anime with ID ${id} not found` };
      }
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get a random anime
   */
  async getRandomAnime() {
    await this.rateLimit();

    try {
      const response = await retryOperation(
        () => axios.get(`${this.config.baseUrl}/random/anime`),
        { retries: 3, context: 'Jikan Random Anime' }
      );

      const anime = response.data.data;
      const data = this.formatAnimeBasic(anime);

      return { success: true, data };
    } catch (error) {
      this.logger.error('Random anime failed:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Format basic anime information
   */
  formatAnimeBasic(anime) {
    return {
      id: anime.mal_id,
      title: anime.title,
      titleEnglish: anime.title_english,
      type: anime.type,
      episodes: anime.episodes,
      status: anime.status,
      score: anime.score,
      rank: anime.rank,
      popularity: anime.popularity,
      synopsis: anime.synopsis?.substring(0, 300) + (anime.synopsis?.length > 300 ? '...' : ''),
      genres: anime.genres?.map(g => g.name) || [],
      imageUrl: anime.images?.jpg?.image_url,
      url: anime.url
    };
  }

  /**
   * Get current anime season based on month
   */
  getCurrentSeason() {
    const month = new Date().getMonth() + 1;
    if (month >= 1 && month <= 3) return 'winter';
    if (month >= 4 && month <= 6) return 'spring';
    if (month >= 7 && month <= 9) return 'summer';
    return 'fall';
  }

  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
  }

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

  formatResponse(response) {
    if (!response.success) {
      return `Error: ${response.error}`;
    }

    const data = response.data;

    // Format single anime (details or random)
    if (data.id && data.synopsis && !data.results) {
      let result = `${data.title}`;
      if (data.titleEnglish && data.titleEnglish !== data.title) {
        result += ` (${data.titleEnglish})`;
      }
      result += `\n\n`;
      result += `Type: ${data.type || 'N/A'} | Episodes: ${data.episodes || 'N/A'} | Status: ${data.status || 'N/A'}\n`;
      result += `Score: ${data.score || 'N/A'}/10 | Rank: #${data.rank || 'N/A'} | Popularity: #${data.popularity || 'N/A'}\n`;

      if (data.genres && data.genres.length > 0) {
        result += `Genres: ${data.genres.join(', ')}\n`;
      }

      if (data.studios && data.studios.length > 0) {
        result += `Studios: ${data.studios.join(', ')}\n`;
      }

      if (data.aired) {
        result += `Aired: ${data.aired}\n`;
      }

      result += `\n${data.synopsis || 'No synopsis available.'}\n`;
      result += `\nMAL: ${data.url}`;

      return result;
    }

    // Format search/list results
    if (data.results) {
      let result = '';

      if (data.query) {
        result += `Search results for "${data.query}":\n\n`;
      } else if (data.season && data.year) {
        result += `${data.season.charAt(0).toUpperCase() + data.season.slice(1)} ${data.year} Anime:\n\n`;
      } else if (data.type) {
        result += `Top ${data.type.toUpperCase()} Anime${data.filter !== 'default' ? ` (${data.filter})` : ''}:\n\n`;
      }

      data.results.forEach((anime, i) => {
        result += `${i + 1}. ${anime.title}`;
        if (anime.titleEnglish && anime.titleEnglish !== anime.title) {
          result += ` (${anime.titleEnglish})`;
        }
        result += `\n`;
        result += `   ID: ${anime.id} | Type: ${anime.type || 'N/A'} | Score: ${anime.score || 'N/A'}/10\n`;
        if (anime.genres && anime.genres.length > 0) {
          result += `   Genres: ${anime.genres.slice(0, 3).join(', ')}\n`;
        }
        result += `\n`;
      });

      return result;
    }

    // Format recommendations
    if (data.recommendations) {
      let result = `Anime recommendations based on ID ${data.basedOn}:\n\n`;

      data.recommendations.forEach((rec, i) => {
        result += `${i + 1}. ${rec.title} (ID: ${rec.id}) - ${rec.votes} votes\n`;
      });

      return result;
    }

    return JSON.stringify(data, null, 2);
  }
}
