import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import webSearchService from '../../services/search/webSearchService.js';
import * as cheerio from 'cheerio';

// A paid call must answer inside the gateway's 60 s wait: the direct tiers go first and
// the last-resort model search gets whatever is left of this budget.
const EXTERNAL_SEARCH_BUDGET_MS = 55000;

/** Items of a Google News RSS search feed. Exported for tests. */
export function parseGoogleNewsRss(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = [];
  $('item').each((_, el) => {
    const item = $(el);
    const title = item.children('title').first().text().trim();
    const url = item.children('link').first().text().trim();
    if (!title || !/^https?:\/\//.test(url)) return;
    const source = item.children('source').first().text().trim();
    const pub = item.children('pubDate').first().text().trim();
    const at = pub ? new Date(pub) : null;
    out.push({
      // Google appends " - <publisher>" to each title; the publisher has its own field.
      title: source && title.endsWith(` - ${source}`) ? title.slice(0, -(source.length + 3)) : title,
      source,
      url,
      publishedAt: at && !isNaN(at) ? at.toISOString() : null
    });
  });
  return out;
}

export default class WebSearchPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'websearch';
    this.version = '2.0.0';
    this.description = 'Web search, stock prices, crypto prices, weather, and news';
    this.commands = [
      {
        command: 'search',
        description: 'AI-mediated web search via the configured provider (OpenAI/Anthropic) using its built-in web search tool',
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
    // Search backends are owned by webSearchService (src/services/search/) —
    // Brave's key is read there. Kept off this class deliberately: it was an
    // unread field here for months.
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
    const external = data._caller === 'external';

    try {
      switch(action) {
        case 'search':
          return await this.webSearch(query, provider, { external });
          
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

  async webSearch(query, preferredProvider = null, { external = false } = {}) {
    if (!query) {
      return { success: false, error: 'Search query is required' };
    }

    logger.info(`Web search for: ${query}${preferredProvider ? ` (preferred: ${preferredProvider})` : ''}${external ? ' (paid API)' : ''}`);

    // A paid API caller wants ranked results with URLs, fast. The model path answers in
    // prose and takes 20-60+ s, and the gateway gives up at 60 s: on 2026-09-30 two paid
    // searches timed out on an instance with no search key, while DuckDuckGo answered the
    // same query in about a second. So a paid call tries both direct tiers first, and the
    // model only as a last resort inside a deadline the gateway can still wait for.
    if (external) {
      const started = Date.now();
      const direct = await this._directSearch(query, 'keyed') || await this._directSearch(query, 'keyless');
      if (direct) return direct;
      const left = EXTERNAL_SEARCH_BUDGET_MS - (Date.now() - started);
      if (left < 5000) return { success: false, error: 'Search backends did not answer in time' };
      let timer;
      const deadline = new Promise(resolve => {
        timer = setTimeout(() => resolve({ success: false, error: `Search timed out after ${Math.round(left / 1000)}s` }), left);
        timer.unref?.();
      });
      try {
        return await Promise.race([this._modelSearch(query, preferredProvider), deadline]);
      } finally {
        clearTimeout(timer);
      }
    }

    // Order: keyed search APIs, then the model's own search tool, then keyless DuckDuckGo.
    // Direct APIs return ranked results with no model in the loop, so the AI provider lock is
    // irrelevant to them. The model path is the only one that returns prose. The keyless
    // backend is last so an instance that searched through its AI provider keeps doing so; it
    // answers when neither of the others can (no key, and a lock or provider with no search).
    const direct = await this._directSearch(query, 'keyed');
    if (direct) return direct;

    const viaModel = await this._modelSearch(query, preferredProvider);
    if (viaModel.success) return viaModel;

    const keyless = await this._directSearch(query, 'keyless');
    if (keyless) return keyless;
    return viaModel;
  }

  /** A direct search-API answer in the plugin's result shape, or null. */
  async _directSearch(query, tier) {
    if (!webSearchService.isAvailable(tier)) return null;
    const direct = await webSearchService.search(query, { tier });
    if (!direct.success) {
      logger.warn(`Direct search (${tier}) failed: ${direct.error}`);
      return null;
    }
    return {
      success: true,
      query,
      provider: direct.provider,
      results: direct.results,
      cached: direct.cached === true,
      // Callers that expect prose get a readable rendering of the same data
      // rather than a shape change.
      result: direct.results.length
        ? direct.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')
        : 'No results found.'
    };
  }

  /** Search through the AI provider's web-search tool (Anthropic/OpenAI/OpenRouter). */
  async _modelSearch(query, preferredProvider) {

    const providerManager = this.agent?.providerManager;
    if (!providerManager) {
      return { success: false, error: 'No AI provider available for web search' };
    }

    // Respect the agent's configured current provider by default. Only honor
    // a caller-supplied preference if one is explicitly passed in. Fallback
    // order ('openai' then 'anthropic') is used only when neither the current
    // provider nor the preference is registered.
    // getCurrentProvider() is async — an un-awaited call yields a Promise, so
    // currentProviderName was always undefined and the "respect the configured provider"
    // branch below could never be taken.
    const currentProviderObj = await providerManager.getCurrentProvider();
    const currentProviderName = currentProviderObj?.name?.toLowerCase();
    const fallbackOrder = ['openai', 'anthropic'];
    let searchOrder;
    if (preferredProvider) {
      const pref = preferredProvider.toLowerCase();
      searchOrder = [pref];
      if (currentProviderName && currentProviderName !== pref) searchOrder.push(currentProviderName);
      for (const p of fallbackOrder) if (!searchOrder.includes(p)) searchOrder.push(p);
    } else if (currentProviderName) {
      searchOrder = [currentProviderName];
      for (const p of fallbackOrder) if (p !== currentProviderName) searchOrder.push(p);
    } else {
      searchOrder = fallbackOrder;
    }

    // Only anthropic.js and openai.js implement the enableWebSearch tool call. Every other
    // provider silently ignores the flag and answers from training data — on HuggingFace that
    // is a 30s time-to-first-byte timeout, and under the provider lock the switch below is
    // refused too, so the call can only ever fail. Ask a provider that can actually search,
    // and only one the lock allows us to spend on; otherwise say so immediately instead of
    // burning 30s per query (7 identical failures inside one plugin-development scan,
    // 2026-08-30).
    const candidates = searchOrder.filter(
      name => providerManager.providers?.get(name)?.supportsWebSearch === true
    );
    // NOTE (2026-09-18, v2.25.312): allowedProviders() changed meaning. It used to filter to
    // the locked provider even when the locked provider was not a candidate, which is what made
    // the refusal below reachable for web search. It now falls through to the normal candidate
    // list in that case — so a lock pointing at a provider WITHOUT web search no longer blocks
    // the spend, it redirects it. Benign while the active provider is itself search-capable
    // (OpenRouter is), but it is a change of intent for this call site specifically; revert
    // to a capability-specific rule here if web search should stay inside the lock.
    const allowed = await providerManager.allowedProviders(candidates, 'web search');

    if (allowed.length === 0) {
      const lockedTo = currentProviderName || 'unknown';
      const reason = candidates.length === 0
        ? 'no registered provider implements web search'
        : `the provider lock pins spend to ${lockedTo}, which has no web search tool`;
      const fix = `${reason}. Configure a direct search backend instead — ${webSearchService.unavailableReason()}`;
      logger.warn(`Web search unavailable: ${fix}`);
      return { success: false, error: `Web search unavailable: ${fix}` };
    }

    const providerName = allowed[0];
    logger.info(`Using ${providerName} provider for web search`);

    const needsSwitch = providerName !== currentProviderName;

    try {
      if (needsSwitch) {
        await providerManager.switchProvider(providerName);
      }

      const response = await providerManager.generateResponse(
        `Search the web for current, real-time information about: ${query}\n\nProvide factual results with sources. If you find relevant URLs, include them.`,
        {
          enableWebSearch: true,
          maxSearches: 2,
          maxTokens: 400,
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

  /** News from Google News' RSS search: no key, ranked by recency and relevance. */
  async _googleNews(query) {
    try {
      logger.info(`Fetching news for: ${query} (Google News RSS)`);
      const res = await axios.get('https://news.google.com/rss/search', {
        params: { q: query, hl: 'en-US', gl: 'US', ceid: 'US:en' },
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' },
        timeout: 10000,
        responseType: 'text'
      });
      const newsResults = parseGoogleNewsRss(String(res.data || '')).slice(0, 10);
      if (!newsResults.length) {
        return { success: true, result: `No news articles found for "${query}".`, data: [], source: 'google_news' };
      }
      const formattedResult = newsResults.map((a, i) =>
        `**${i + 1}. ${a.title}**\n` +
        `Source: ${a.source || 'unknown'}${a.publishedAt ? ` | ${new Date(a.publishedAt).toLocaleDateString()}` : ''}\n` +
        `[Read more](${a.url})`
      ).join('\n\n');
      return { success: true, result: formattedResult, data: newsResults, source: 'google_news' };
    } catch (error) {
      logger.error('Google News RSS error:', error.message);
      return { success: false, error: `Failed to fetch news: ${error.message}`, source: 'google_news' };
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

    // Without a NewsAPI key (its free tier is licensed for development only), read
    // Google News' public RSS search instead of failing every call.
    if (!this.newsApiKey) return await this._googleNews(query);

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
        logger.warn('NewsAPI rate limit reached — answering from Google News RSS');
        return await this._googleNews(query);
      }
      
      return { 
        success: false, 
        error: `Failed to fetch news: ${error.message}`,
        source: 'newsapi'
      };
    }
  }
}