import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

export default class WebSearchPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'websearch';
    this.version = '2.0.0';
    this.description = 'Web search, stock prices, crypto prices, weather, and news';
    this.commands = [
      {
        command: 'search',
        description: 'Search the web for information using DuckDuckGo or Brave Search',
        usage: 'search [query]',
        offerAsService: true
      },
      {
        command: 'stock',
        description: 'Get current stock price from Yahoo Finance',
        usage: 'stock [symbol]',
        offerAsService: true
      },
      {
        command: 'crypto',
        description: 'Get current cryptocurrency price from CoinGecko',
        usage: 'crypto [symbol]',
        offerAsService: true
      },
      {
        command: 'weather',
        description: 'Get current weather for a location',
        usage: 'weather [location]',
        offerAsService: true
      },
      {
        command: 'news',
        description: 'Get current news articles related to a query',
        usage: 'news [query]',
        offerAsService: true
      }
    ];

    this.newsApiKey = process.env.NEWS_API_KEY;
    this.braveApiKey = process.env.BRAVE_SEARCH_API_KEY;
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
    const { query, symbol, location, provider } = data;

    try {
      switch(action) {
        case 'search':
          return await this.webSearch(query, provider);
          
        case 'stock':
          return await this.getStockPrice(symbol);
          
        case 'crypto':
          return await this.getCryptoPrice(symbol);
          
        case 'weather':
          return await this.getWeather(location);
          
        case 'news':
          return await this.getNews(query);
          
        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: search, stock, crypto, weather, or news' 
          };
      }
    } catch (error) {
      logger.error('WebSearch plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async webSearch(query, preferredProvider = null) {
    if (!query) {
      return { success: false, error: 'Search query is required' };
    }

    logger.info(`Web search for: ${query}${preferredProvider ? ` (preferred: ${preferredProvider})` : ''}`);

    const providerManager = this.agent?.providerManager;
    if (!providerManager) {
      return { success: false, error: 'No AI provider available for web search' };
    }

    // Build priority list — caller preference first, then default order
    const defaultOrder = ['anthropic', 'openai'];
    let searchOrder;
    if (preferredProvider) {
      const pref = preferredProvider.toLowerCase();
      searchOrder = [pref, ...defaultOrder.filter(p => p !== pref)];
    } else {
      searchOrder = defaultOrder;
    }

    // Find first available web-search-capable provider
    let provider = null;
    let providerName = null;
    for (const name of searchOrder) {
      if (providerManager.providers?.has(name)) {
        provider = providerManager.providers.get(name);
        providerName = name;
        break;
      }
    }

    if (!provider) {
      // Fall back to current provider
      provider = providerManager.getCurrentProvider();
      providerName = provider?.name?.toLowerCase() || 'unknown';
    }

    logger.info(`Using ${providerName} provider for web search`);

    const currentProviderName = providerManager.getCurrentProvider()?.name?.toLowerCase();
    const needsSwitch = providerName !== currentProviderName;

    try {
      if (needsSwitch) {
        await providerManager.switchProvider(providerName);
      }

      const response = await providerManager.generateResponse(
        `Search the web for current, real-time information about: ${query}\n\nProvide factual results with sources. If you find relevant URLs, include them.`,
        {
          enableWebSearch: true,
          maxSearches: 5,
          maxTokens: 800,
          temperature: 0.3,
          systemPrompt: 'You are a web search assistant. Use your web search tool to find current, accurate information. Always cite your sources with URLs. Present results clearly and factually.'
        }
      );

      const resultText = response.content;

      if (!resultText) {
        throw new Error(`No response from ${providerName}`);
      }

      // Extract any URLs from the response for structured data
      const urlRegex = /https?:\/\/[^\s)>\]"']+/g;
      const urls = [...new Set((resultText.match(urlRegex) || []))];
      const searchResults = urls.map(url => ({ url, title: '', snippet: '' }));

      return {
        success: true,
        result: resultText,
        data: searchResults.length > 0 ? searchResults : [{ title: 'Search Results', url: '', snippet: resultText }],
        source: `${providerName}_web_search`,
        provider: providerName
      };
    } catch (error) {
      logger.error('Web search error:', error.message || error);
      return { success: false, error: `Search failed: ${error.message}` };
    } finally {
      // Switch back if we changed providers
      if (needsSwitch && currentProviderName) {
        try {
          await providerManager.switchProvider(currentProviderName);
        } catch (e) {
          logger.warn('Failed to switch back to original provider:', e.message);
        }
      }
    }
  }

  async getStockPrice(symbol) {
    if (!symbol) {
      return { 
        success: false, 
        error: 'Stock symbol is required' 
      };
    }

    try {
      logger.info(`Fetching stock price for ${symbol.toUpperCase()}`);
      
      // Use Yahoo Finance API (free, no API key required)
      const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}`, {
        timeout: 10000
      });
      
      const data = response.data.chart.result[0];
      if (!data || !data.meta) {
        return {
          success: true,
          result: `Stock symbol ${symbol.toUpperCase()} not found. Please check the symbol and try again.`,
          source: 'api_error'
        };
      }

      const meta = data.meta;
      const price = meta.regularMarketPrice;
      const previousClose = meta.previousClose;
      const change = price - previousClose;
      const changePercent = ((change / previousClose) * 100);
      const changeEmoji = change >= 0 ? '📈' : '📉';
      
      return {
        success: true,
        result: `📊 **${symbol.toUpperCase()}** (${meta.longName || meta.symbol})\n\n💵 **Price**: $${price.toFixed(2)}\n${changeEmoji} **Change**: ${change >= 0 ? '+' : ''}$${change.toFixed(2)} (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)\n\n🏢 **Exchange**: ${meta.exchangeName}\n🕒 **Market**: ${meta.marketState}\n\n*Data from Yahoo Finance*`,
        source: 'yahoo_finance'
      };
      
    } catch (error) {
      logger.error('Stock price API error:', error.message);
      
      return {
        success: true,
        result: `I cannot access real-time stock prices for ${symbol.toUpperCase()} right now. For current stock prices, please check a financial website like Yahoo Finance, Google Finance, or Bloomberg.`,
        source: 'fallback'
      };
    }
  }

  async getCryptoPrice(symbol) {
    if (!symbol) {
      return { 
        success: false, 
        error: 'Cryptocurrency symbol is required' 
      };
    }

    try {
      logger.info(`Fetching crypto price for: ${symbol}`);
      
      // First, try to find the coin using CoinGecko's search
      let coinId = null;
      
      // Map common symbols to CoinGecko IDs for speed
      const symbolMap = {
        'BTC': 'bitcoin', 'BITCOIN': 'bitcoin',
        'ETH': 'ethereum', 'ETHEREUM': 'ethereum',
        'ADA': 'cardano', 'CARDANO': 'cardano', 
        'DOT': 'polkadot', 'POLKADOT': 'polkadot',
        'LTC': 'litecoin', 'LITECOIN': 'litecoin',
        'XRP': 'ripple', 'RIPPLE': 'ripple',
        'BNB': 'binancecoin', 'BINANCE': 'binancecoin',
        'SOL': 'solana', 'SOLANA': 'solana',
        'MATIC': 'matic-network', 'POLYGON': 'matic-network',
        'AVAX': 'avalanche-2', 'AVALANCHE': 'avalanche-2',
        'LINK': 'chainlink', 'CHAINLINK': 'chainlink',
        'DOGE': 'dogecoin', 'DOGECOIN': 'dogecoin',
        'SHIB': 'shiba-inu', 'SHIBAINU': 'shiba-inu',
        'UNI': 'uniswap', 'UNISWAP': 'uniswap',
        'ATOM': 'cosmos', 'COSMOS': 'cosmos'
      };
      
      coinId = symbolMap[symbol.toUpperCase()];
      
      // If not in our map, search CoinGecko
      if (!coinId) {
        try {
          const searchResponse = await axios.get(`https://api.coingecko.com/api/v3/search?query=${symbol}`, {
            timeout: 5000
          });
          
          const coins = searchResponse.data.coins;
          if (coins && coins.length > 0) {
            // Take the first match (usually most relevant)
            coinId = coins[0].id;
            logger.info(`Found crypto via search: ${symbol} -> ${coinId}`);
          }
        } catch (searchError) {
          logger.warn('CoinGecko search failed, trying direct ID:', searchError.message);
          coinId = symbol.toLowerCase(); // Fallback to direct ID
        }
      }
      
      if (!coinId) {
        coinId = symbol.toLowerCase();
      }
      
      // Get price data
      const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`, {
        timeout: 10000
      });
      
      const data = response.data[coinId];
      if (!data) {
        return {
          success: true,
          result: `Cryptocurrency "${symbol}" not found. Please check the name/symbol and try again.`,
          source: 'api_error'
        };
      }

      const price = data.usd;
      const change24h = data.usd_24h_change;
      const changeEmoji = change24h >= 0 ? '📈' : '📉';
      
      return {
        success: true,
        result: `💰 **${symbol.toUpperCase()}** Price: **$${price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 8})}**\n\n${changeEmoji} 24h Change: **${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%**\n\n*Data from CoinGecko*`,
        source: 'coingecko'
      };
      
    } catch (error) {
      logger.error('Crypto price API error:', error.message);
      
      return {
        success: true,
        result: `I cannot access real-time cryptocurrency prices for ${symbol.toUpperCase()} right now. For current crypto prices, please check CoinMarketCap, CoinGecko, or your preferred exchange.`,
        source: 'fallback'
      };
    }
  }

  async getWeather(location) {
    if (!location) {
      return { success: false, error: 'Location is required' };
    }

    try {
      logger.info(`Getting weather for: ${location}`);

      // wttr.in — free weather API, no key needed
      const response = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, {
        timeout: 10000,
        headers: { 'User-Agent': 'curl/7.68.0' }
      });

      const data = response.data;
      const current = data.current_condition?.[0];
      const area = data.nearest_area?.[0];

      if (!current) {
        return { success: false, error: `No weather data found for "${location}"` };
      }

      const areaName = area?.areaName?.[0]?.value || location;
      const country = area?.country?.[0]?.value || '';
      const tempC = current.temp_C;
      const tempF = current.temp_F;
      const desc = current.weatherDesc?.[0]?.value || 'Unknown';
      const humidity = current.humidity;
      const windMph = current.windspeedMiles;
      const windDir = current.winddir16Point;
      const feelsLikeC = current.FeelsLikeC;
      const feelsLikeF = current.FeelsLikeF;
      const visibility = current.visibility;
      const uvIndex = current.uvIndex;

      const result = `Weather for ${areaName}${country ? ', ' + country : ''}:\n` +
        `${desc}, ${tempC}°C / ${tempF}°F (feels like ${feelsLikeC}°C / ${feelsLikeF}°F)\n` +
        `Humidity: ${humidity}% | Wind: ${windMph} mph ${windDir} | UV: ${uvIndex} | Visibility: ${visibility} km`;

      return {
        success: true,
        result,
        data: {
          location: areaName,
          country,
          temperature: { celsius: parseInt(tempC), fahrenheit: parseInt(tempF) },
          feelsLike: { celsius: parseInt(feelsLikeC), fahrenheit: parseInt(feelsLikeF) },
          condition: desc,
          humidity: parseInt(humidity),
          wind: { speed: parseInt(windMph), direction: windDir },
          uvIndex: parseInt(uvIndex),
          visibility: parseInt(visibility)
        },
        source: 'wttr.in'
      };
    } catch (error) {
      logger.error('Weather API error:', error.message);
      return { success: false, error: `Weather lookup failed: ${error.message}` };
    }
  }

  async getNews(query) {
    if (!query) {
      return { 
        success: false, 
        error: 'News query is required' 
      };
    }

    if (!this.newsApiKey) {
      return {
        success: false,
        error: 'News API key is not configured. Please set NEWS_API_KEY environment variable.'
      };
    }

    try {
      logger.info(`Fetching news for: ${query}`);
      
      const response = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: query,
          apiKey: this.newsApiKey,
          sortBy: 'publishedAt',
          language: 'en',
          pageSize: 10
        },
        timeout: 10000
      });

      const articles = response.data.articles;
      if (!articles || articles.length === 0) {
        return {
          success: true,
          result: `No news articles found for "${query}".`,
          source: 'newsapi'
        };
      }

      // Format the news results
      const newsResults = articles.slice(0, 5).map(article => ({
        title: article.title,
        description: article.description,
        source: article.source.name,
        url: article.url,
        publishedAt: article.publishedAt
      }));

      const formattedResult = newsResults.map((article, index) => 
        `**${index + 1}. ${article.title}**\n` +
        `Source: ${article.source} | ${new Date(article.publishedAt).toLocaleDateString()}\n` +
        `${article.description || 'No description available'}\n` +
        `[Read more](${article.url})`
      ).join('\n\n');

      return {
        success: true,
        result: formattedResult,
        data: newsResults,
        source: 'newsapi'
      };

    } catch (error) {
      logger.error('News API error:', error.message);
      
      // Handle specific error cases
      if (error.response?.status === 401) {
        return {
          success: false,
          error: 'Invalid NEWS_API_KEY. Please check your API key configuration.'
        };
      }
      
      if (error.response?.status === 429) {
        return {
          success: false,
          error: 'News API rate limit exceeded. Please try again later.'
        };
      }
      
      return { 
        success: false, 
        error: `Failed to fetch news: ${error.message}`,
        source: 'newsapi'
      };
    }
  }
}