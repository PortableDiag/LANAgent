import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import UserPreference from '../../models/UserPreference.js';

/**
 * News API Plugin
 * 
 * Provides access to news articles from around the world
 * 
 * Usage Examples:
 * - Natural language: "get latest technology news"
 * - Command format: api news headlines technology
 * - Telegram: Just type naturally about news
 */
export default class NewsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'news';
    this.version = '1.1.0';
    this.description = 'News articles and headlines API with personalized recommendations';
    this.category = 'data';
    this.commands = [
      {
        command: 'headlines',
        description: 'Get top headlines',
        usage: 'headlines [category] [country]',
        offerAsService: true
      },
      {
        command: 'everything',
        description: 'Search all articles',
        usage: 'everything [query] [from] [to] [sortBy]',
        offerAsService: true
      },
      {
        command: 'sources',
        description: 'Get news sources',
        usage: 'sources [category] [country] [language]',
        offerAsService: true
      },
      {
        command: 'setPreferences',
        description: 'Set user preferences for news categories',
        usage: 'setPreferences [categories] [userId]',
        offerAsService: false
      },
      {
        command: 'getPreferences',
        description: 'Get current user preferences',
        usage: 'getPreferences [userId]',
        offerAsService: false
      },
      {
        command: 'getPersonalizedNews',
        description: 'Get personalized news based on user preferences',
        usage: 'getPersonalizedNews [userId] [country]',
        offerAsService: true
      }
    ];
    
    this.requiredCredentials = [
      { key: 'apiKey', label: 'News API Key', envVar: 'NEWS_API_KEY', altEnvVars: ['NEWSAPI_KEY'], required: true }
    ];
    this.apiKey = '';
    this.baseURL = 'https://newsapi.org/v2';
  }

  async initialize() {
    try {
      const credentials = await this.loadCredentials(this.requiredCredentials);
      this.apiKey = credentials.apiKey || process.env.NEWS_API_KEY || process.env.NEWSAPI_KEY || '';
      if (this.apiKey) {
        this.logger.info('News plugin initialized with API key');
      }
    } catch (err) {
      this.logger.warn('News plugin init:', err.message);
      this.apiKey = process.env.NEWS_API_KEY || process.env.NEWSAPI_KEY || '';
    }
  }

  async execute(action, params = {}) {
    try {
      logger.info(`Executing ${this.name}.${action} with params:`, params);
      
      if (!this.apiKey) {
        return { error: 'News API key not configured. Please set NEWS_API_KEY environment variable.' };
      }
      
      switch (action) {
        case 'headlines':
          return await this.getHeadlines(params);
        case 'everything':
          return await this.searchEverything(params);
        case 'sources':
          return await this.getSources(params);
        case 'setPreferences':
          return await this.setUserPreferences(params);
        case 'getPreferences':
          return await this.getUserPreferences(params);
        case 'getPersonalizedNews':
          return await this.getPersonalizedNews(params);
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (error) {
      logger.error(`Error in ${this.name}.${action}:`, error);
      return { error: error.message || 'An error occurred' };
    }
  }

  async getHeadlines({ category = '', country = 'us', pageSize = 10, page = 1 }) {
    try {
      const params = {
        apiKey: this.apiKey,
        country,
        pageSize: Math.min(pageSize, 100),
        page
      };
      
      if (category) {
        const validCategories = ['business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology'];
        if (validCategories.includes(category.toLowerCase())) {
          params.category = category.toLowerCase();
        }
      }

      const response = await axios.get(`${this.baseURL}/top-headlines`, { params });
      
      const articles = response.data.articles.map(article => ({
        title: article.title,
        description: article.description,
        url: article.url,
        source: article.source.name,
        author: article.author,
        publishedAt: article.publishedAt,
        urlToImage: article.urlToImage,
        content: article.content?.substring(0, 200)
      }));

      return {
        status: 'ok',
        totalResults: response.data.totalResults,
        category: params.category || 'general',
        country,
        articles,
        page,
        totalPages: Math.ceil(response.data.totalResults / pageSize)
      };
    } catch (error) {
      logger.error('News headlines error:', error);
      if (error.response?.status === 401) {
        return { error: 'Invalid API key' };
      } else if (error.response?.status === 429) {
        return { error: 'API rate limit exceeded' };
      }
      return { error: 'Failed to fetch headlines' };
    }
  }

  async searchEverything({ query, from = '', to = '', sortBy = 'publishedAt', language = 'en', pageSize = 10, page = 1 }) {
    if (!query) {
      return { error: 'Search query is required' };
    }

    try {
      const params = {
        apiKey: this.apiKey,
        q: query,
        language,
        sortBy, // relevancy, popularity, publishedAt
        pageSize: Math.min(pageSize, 100),
        page
      };
      
      // Add date filters if provided
      if (from) {
        params.from = from;
      }
      if (to) {
        params.to = to;
      }

      const response = await axios.get(`${this.baseURL}/everything`, { params });
      
      const articles = response.data.articles.map(article => ({
        title: article.title,
        description: article.description,
        url: article.url,
        source: article.source.name,
        author: article.author,
        publishedAt: article.publishedAt,
        urlToImage: article.urlToImage,
        content: article.content?.substring(0, 200)
      }));

      return {
        status: 'ok',
        query,
        totalResults: response.data.totalResults,
        articles,
        page,
        totalPages: Math.ceil(response.data.totalResults / pageSize),
        sortBy
      };
    } catch (error) {
      logger.error('News search error:', error);
      if (error.response?.status === 401) {
        return { error: 'Invalid API key' };
      } else if (error.response?.status === 429) {
        return { error: 'API rate limit exceeded' };
      }
      return { error: 'Failed to search articles' };
    }
  }

  async getSources({ category = '', country = '', language = 'en' }) {
    try {
      const params = {
        apiKey: this.apiKey
      };
      
      if (category) {
        const validCategories = ['business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology'];
        if (validCategories.includes(category.toLowerCase())) {
          params.category = category.toLowerCase();
        }
      }
      
      if (country) {
        params.country = country.toLowerCase();
      }
      
      if (language) {
        params.language = language.toLowerCase();
      }

      const response = await axios.get(`${this.baseURL}/sources`, { params });
      
      const sources = response.data.sources.map(source => ({
        id: source.id,
        name: source.name,
        description: source.description,
        url: source.url,
        category: source.category,
        language: source.language,
        country: source.country
      }));

      return {
        status: 'ok',
        sources,
        count: sources.length,
        filters: {
          category: params.category || 'all',
          country: params.country || 'all',
          language: params.language || 'all'
        }
      };
    } catch (error) {
      logger.error('News sources error:', error);
      if (error.response?.status === 401) {
        return { error: 'Invalid API key' };
      } else if (error.response?.status === 429) {
        return { error: 'API rate limit exceeded' };
      }
      return { error: 'Failed to fetch sources' };
    }
  }

  /**
   * Set user preferences for news categories
   * @param {Object} params - Parameters containing user preferences
   * @returns {Object} - Confirmation of preferences set
   */
  async setUserPreferences({ categories = [], userId = 'default' }) {
    if (!Array.isArray(categories) || categories.length === 0) {
      return { error: 'Categories must be a non-empty array' };
    }
    
    // Validate categories
    const validCategories = ['business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology'];
    const normalizedCategories = categories
      .map(cat => cat.toLowerCase())
      .filter(cat => validCategories.includes(cat));
    
    if (normalizedCategories.length === 0) {
      return { 
        error: 'No valid categories provided', 
        validCategories 
      };
    }
    
    try {
      await UserPreference.setPreferences(
        'news',
        userId,
        'categories',
        { categories: normalizedCategories }
      );
      
      return { 
        status: 'ok', 
        message: 'Preferences updated successfully', 
        preferences: { categories: normalizedCategories }
      };
    } catch (error) {
      logger.error('Error setting news preferences:', error);
      return { error: 'Failed to save preferences' };
    }
  }

  /**
   * Get user preferences
   * @param {Object} params - Parameters containing userId
   * @returns {Object} - User preferences
   */
  async getUserPreferences({ userId = 'default' }) {
    try {
      const preferences = await UserPreference.getPreferences('news', userId, 'categories');
      
      if (!preferences || preferences.size === 0) {
        return { 
          status: 'ok',
          preferences: { categories: [] },
          message: 'No preferences set'
        };
      }
      
      return {
        status: 'ok',
        preferences: preferences.get('categories') || { categories: [] }
      };
    } catch (error) {
      logger.error('Error getting news preferences:', error);
      return { error: 'Failed to retrieve preferences' };
    }
  }

  /**
   * Get personalized news based on user preferences
   * @param {Object} params - Parameters including userId and country
   * @returns {Object} - Personalized news articles
   */
  async getPersonalizedNews({ userId = 'default', country = 'us', pageSize = 10, page = 1 }) {
    try {
      // Get user preferences
      const prefResult = await this.getUserPreferences({ userId });
      if (prefResult.error) {
        return prefResult;
      }
      
      const categories = prefResult.preferences?.categories || [];
      if (categories.length === 0) {
        return { 
          error: 'User preferences not set. Please set preferences using setPreferences command.',
          hint: 'Use: news.setPreferences categories:[business,technology,science]'
        };
      }
      
      // Fetch articles for each preferred category
      const allArticles = [];
      const articlesPerCategory = Math.ceil(pageSize / categories.length);
      
      for (const category of categories) {
        const response = await this.getHeadlines({ 
          category, 
          country, 
          pageSize: articlesPerCategory 
        });
        
        if (response.status === 'ok' && response.articles) {
          // Tag articles with their category
          response.articles.forEach(article => {
            article.category = category;
          });
          allArticles.push(...response.articles);
        }
      }
      
      // Shuffle articles to mix categories
      const shuffled = allArticles.sort(() => Math.random() - 0.5);
      
      // Paginate results
      const startIndex = (page - 1) * pageSize;
      const paginatedArticles = shuffled.slice(startIndex, startIndex + pageSize);
      
      return {
        status: 'ok',
        totalResults: allArticles.length,
        articles: paginatedArticles,
        page,
        totalPages: Math.ceil(allArticles.length / pageSize),
        categories: categories.join(', '),
        personalized: true
      };
    } catch (error) {
      logger.error('Personalized news error:', error);
      return { error: 'Failed to fetch personalized news' };
    }
  }

  formatResponse(response) {
    if (response.error) {
      return `❌ Error: ${response.error}`;
    }

    if (response.articles) {
      let result = `📰 News Articles`;
      
      if (response.query) {
        result += ` for "${response.query}"`;
      } else if (response.category && response.category !== 'general') {
        result += ` - ${response.category.charAt(0).toUpperCase() + response.category.slice(1)}`;
      }
      
      result += `\n📊 Total Results: ${response.totalResults}`;
      result += `\n📄 Page ${response.page || 1} of ${response.totalPages || 1}\n\n`;
      
      response.articles.forEach((article, index) => {
        result += `${index + 1}. ${article.title}\n`;
        result += `   📝 ${article.source}`;
        if (article.author) {
          result += ` | By ${article.author}`;
        }
        result += `\n   📅 ${new Date(article.publishedAt).toLocaleDateString()}\n`;
        if (article.description) {
          result += `   ${article.description.substring(0, 100)}...\n`;
        }
        result += `   🔗 ${article.url}\n\n`;
      });
      
      return result;
    }

    if (response.sources) {
      let result = `📰 News Sources`;
      
      if (response.filters) {
        const activeFilters = [];
        if (response.filters.category !== 'all') activeFilters.push(`Category: ${response.filters.category}`);
        if (response.filters.country !== 'all') activeFilters.push(`Country: ${response.filters.country}`);
        if (response.filters.language !== 'all') activeFilters.push(`Language: ${response.filters.language}`);
        
        if (activeFilters.length > 0) {
          result += ` (${activeFilters.join(', ')})`;
        }
      }
      
      result += `\n📊 Total Sources: ${response.count}\n\n`;
      
      response.sources.forEach((source, index) => {
        result += `${index + 1}. ${source.name}\n`;
        result += `   📝 ${source.description?.substring(0, 100)}...\n`;
        result += `   🌐 ${source.url}\n`;
        result += `   📁 Category: ${source.category} | 🌍 ${source.country?.toUpperCase()} | 🗣️ ${source.language}\n\n`;
      });
      
      return result;
    }

    // Handle preference-related responses
    if (response.preferences) {
      if (response.message === 'No preferences set') {
        return '📰 No news preferences set\n💡 Use setPreferences to customize your news feed';
      }
      
      const categories = response.preferences.categories || [];
      let result = '📰 News Preferences\n';
      
      if (response.message === 'Preferences updated successfully') {
        result = '✅ ' + result;
      }
      
      if (categories.length > 0) {
        result += `📁 Categories: ${categories.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ')}\n`;
      }
      
      return result;
    }
    
    // Handle personalized news
    if (response.personalized) {
      let result = `📰 Personalized News Feed\n`;
      result += `📁 Your Categories: ${response.categories}\n`;
      result += `📊 Total Results: ${response.totalResults}`;
      result += `\n📄 Page ${response.page || 1} of ${response.totalPages || 1}\n\n`;
      
      response.articles.forEach((article, index) => {
        result += `${index + 1}. ${article.title}\n`;
        result += `   📝 ${article.source}`;
        if (article.category) {
          result += ` | 📁 ${article.category.charAt(0).toUpperCase() + article.category.slice(1)}`;
        }
        result += `\n`;
        if (article.description) {
          result += `   ${article.description.substring(0, 150)}...\n`;
        }
        result += `   🔗 ${article.url}\n`;
        result += `   🕐 ${article.date}\n\n`;
      });
      
      return result;
    }
    
    return JSON.stringify(response, null, 2);
  }

  async detectIntent(input) {
    const newsKeywords = [
      'news', 'article', 'headlines', 'breaking', 'latest',
      'today', 'current events', 'newspaper', 'journalism',
      'media', 'press', 'report'
    ];
    
    const categoryKeywords = {
      business: ['business', 'economy', 'finance', 'market', 'stock'],
      entertainment: ['entertainment', 'celebrity', 'movie', 'tv', 'music'],
      health: ['health', 'medical', 'medicine', 'disease', 'wellness'],
      science: ['science', 'research', 'study', 'discovery', 'space'],
      sports: ['sports', 'game', 'match', 'player', 'team'],
      technology: ['technology', 'tech', 'gadget', 'software', 'computer']
    };
    
    const lowerInput = input.toLowerCase();
    const hasNewsKeyword = newsKeywords.some(keyword => lowerInput.includes(keyword));
    
    if (hasNewsKeyword || Object.values(categoryKeywords).flat().some(keyword => lowerInput.includes(keyword))) {
      // Check for search intent
      if (lowerInput.includes('search') || lowerInput.includes('about') || lowerInput.includes('find')) {
        return { action: 'everything', confidence: 0.8 };
      }
      
      // Check for sources intent
      if (lowerInput.includes('source') || lowerInput.includes('publisher') || lowerInput.includes('provider')) {
        return { action: 'sources', confidence: 0.8 };
      }
      
      // Default to headlines with category detection
      let detectedCategory = null;
      for (const [category, keywords] of Object.entries(categoryKeywords)) {
        if (keywords.some(keyword => lowerInput.includes(keyword))) {
          detectedCategory = category;
          break;
        }
      }
      
      return { 
        action: 'headlines', 
        confidence: 0.9,
        params: detectedCategory ? { category: detectedCategory } : {}
      };
    }
    
    return null;
  }
}