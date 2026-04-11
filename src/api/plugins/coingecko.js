import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

/**
 * CoinGecko Cryptocurrency Data Plugin
 * 
 * Provides access to cryptocurrency market data, prices, and information
 * 
 * Usage Examples:
 * - Natural language: "get bitcoin price from coingecko"
 * - Command format: api coingecko price bitcoin usd
 * - Telegram: Just type naturally about crypto prices
 */
export default class CoinGeckoPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'coingecko';
    this.version = '1.0.0';
    this.description = 'Cryptocurrency market data API';
    this.category = 'data';
    this.commands = [
      {
        command: 'price',
        description: 'Get current price of cryptocurrency',
        usage: 'price [coinId] [vs_currency]'
      },
      {
        command: 'marketData',
        description: 'Get detailed market data for a coin',
        usage: 'marketData [coinId]'
      },
      {
        command: 'trending',
        description: 'Get trending cryptocurrencies',
        usage: 'trending'
      },
      {
        command: 'search',
        description: 'Search for a cryptocurrency',
        usage: 'search [query]'
      },
      {
        command: 'exchanges',
        description: 'List top exchanges by volume',
        usage: 'exchanges [per_page]'
      },
      {
        command: 'global',
        description: 'Get global cryptocurrency market data',
        usage: 'global'
      },
      {
        command: 'historicalData',
        description: 'Get historical data for a cryptocurrency',
        usage: 'historicalData [coinId] [date]'
      }
    ];
    
    // API configuration
    this.apiKey = process.env.COINGECKO_API_KEY || '';
    this.baseURL = this.apiKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
    this.headers = this.apiKey ? { 'x-cg-pro-api-key': this.apiKey } : {};
  }

  async execute(action, params = {}) {
    try {
      logger.info(`Executing ${this.name}.${action} with params:`, params);
      
      switch (action) {
        case 'price':
          return await this.getPrice(params);
        case 'marketData':
          return await this.getMarketData(params);
        case 'trending':
          return await this.getTrending();
        case 'search':
          return await this.searchCoin(params);
        case 'exchanges':
          return await this.getExchanges(params);
        case 'global':
          return await this.getGlobalData();
        case 'historicalData':
          return await this.getHistoricalData(params);
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (error) {
      logger.error(`Error in ${this.name}.${action}:`, error);
      return { error: error.message || 'An error occurred' };
    }
  }

  async getPrice({ coinId = 'bitcoin', vs_currency = 'usd' }) {
    try {
      const response = await axios.get(`${this.baseURL}/simple/price`, {
        headers: this.headers,
        params: {
          ids: coinId,
          vs_currencies: vs_currency,
          include_market_cap: true,
          include_24hr_vol: true,
          include_24hr_change: true
        }
      });

      const data = response.data[coinId];
      if (!data) {
        return { error: `Coin ${coinId} not found` };
      }

      return {
        coin: coinId,
        price: data[vs_currency],
        currency: vs_currency.toUpperCase(),
        marketCap: data[`${vs_currency}_market_cap`],
        volume24h: data[`${vs_currency}_24h_vol`],
        change24h: data[`${vs_currency}_24h_change`],
        formattedPrice: `${this.formatNumber(data[vs_currency])} ${vs_currency.toUpperCase()}`,
        formattedMarketCap: this.formatNumber(data[`${vs_currency}_market_cap`]),
        formattedVolume: this.formatNumber(data[`${vs_currency}_24h_vol`]),
        changePercent: `${data[`${vs_currency}_24h_change`]?.toFixed(2)}%`
      };
    } catch (error) {
      logger.error('CoinGecko price error:', error);
      return { error: 'Failed to fetch price data' };
    }
  }

  async getMarketData({ coinId = 'bitcoin' }) {
    try {
      const response = await axios.get(`${this.baseURL}/coins/${coinId}`, {
        headers: this.headers,
        params: {
          localization: false,
          tickers: false,
          community_data: false,
          developer_data: false
        }
      });

      const coin = response.data;
      const marketData = coin.market_data;

      return {
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        currentPrice: {
          usd: marketData.current_price.usd,
          btc: marketData.current_price.btc,
          eth: marketData.current_price.eth
        },
        marketCap: marketData.market_cap.usd,
        marketCapRank: coin.market_cap_rank,
        totalVolume: marketData.total_volume.usd,
        high24h: marketData.high_24h.usd,
        low24h: marketData.low_24h.usd,
        priceChange24h: marketData.price_change_24h,
        priceChangePercentage24h: marketData.price_change_percentage_24h,
        circulatingSupply: marketData.circulating_supply,
        totalSupply: marketData.total_supply,
        ath: {
          usd: marketData.ath.usd,
          date: marketData.ath_date.usd,
          changePercentage: marketData.ath_change_percentage.usd
        },
        atl: {
          usd: marketData.atl.usd,
          date: marketData.atl_date.usd,
          changePercentage: marketData.atl_change_percentage.usd
        }
      };
    } catch (error) {
      logger.error('CoinGecko market data error:', error);
      return { error: 'Failed to fetch market data' };
    }
  }

  async getTrending() {
    try {
      const response = await axios.get(`${this.baseURL}/search/trending`, {
        headers: this.headers
      });

      const trending = response.data.coins.map(item => ({
        id: item.item.id,
        name: item.item.name,
        symbol: item.item.symbol,
        marketCapRank: item.item.market_cap_rank,
        thumb: item.item.thumb,
        score: item.item.score
      }));

      return {
        trending,
        count: trending.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('CoinGecko trending error:', error);
      return { error: 'Failed to fetch trending data' };
    }
  }

  async searchCoin({ query }) {
    if (!query) {
      return { error: 'Search query is required' };
    }

    try {
      const response = await axios.get(`${this.baseURL}/search`, {
        headers: this.headers,
        params: { query }
      });

      const coins = response.data.coins.slice(0, 10).map(coin => ({
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol,
        marketCapRank: coin.market_cap_rank,
        thumb: coin.thumb
      }));

      return {
        query,
        results: coins,
        count: coins.length
      };
    } catch (error) {
      logger.error('CoinGecko search error:', error);
      return { error: 'Failed to search coins' };
    }
  }

  async getExchanges({ per_page = 10 }) {
    try {
      const response = await axios.get(`${this.baseURL}/exchanges`, {
        headers: this.headers,
        params: {
          per_page: Math.min(per_page, 250),
          page: 1
        }
      });

      const exchanges = response.data.map(exchange => ({
        id: exchange.id,
        name: exchange.name,
        country: exchange.country,
        url: exchange.url,
        trustScore: exchange.trust_score,
        trustScoreRank: exchange.trust_score_rank,
        tradeVolume24hBtc: exchange.trade_volume_24h_btc,
        tradeVolume24hBtcNormalized: exchange.trade_volume_24h_btc_normalized,
        yearEstablished: exchange.year_established
      }));

      return {
        exchanges,
        count: exchanges.length
      };
    } catch (error) {
      logger.error('CoinGecko exchanges error:', error);
      return { error: 'Failed to fetch exchanges data' };
    }
  }

  async getGlobalData() {
    try {
      const response = await axios.get(`${this.baseURL}/global`, {
        headers: this.headers
      });

      const data = response.data.data;

      return {
        activeCryptocurrencies: data.active_cryptocurrencies,
        markets: data.markets,
        totalMarketCap: {
          usd: data.total_market_cap.usd,
          change24h: data.market_cap_change_percentage_24h_usd
        },
        totalVolume: {
          usd: data.total_volume.usd
        },
        marketCapPercentage: {
          btc: data.market_cap_percentage.btc,
          eth: data.market_cap_percentage.eth,
          top10: Object.entries(data.market_cap_percentage)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 10)
            .map(([coin, percentage]) => ({ coin, percentage: percentage.toFixed(2) }))
        },
        defiVolume24h: data.defi_volume_24h,
        defiMarketCap: data.defi_market_cap
      };
    } catch (error) {
      logger.error('CoinGecko global data error:', error);
      return { error: 'Failed to fetch global data' };
    }
  }

  /**
   * Get historical data for a specific cryptocurrency
   * @param {Object} params - Parameters for fetching historical data
   * @param {string} params.coinId - The ID of the cryptocurrency
   * @param {string} params.date - The date for historical data in 'dd-mm-yyyy' format
   * @returns {Object} Historical data for the specified cryptocurrency
   */
  async getHistoricalData({ coinId = 'bitcoin', date }) {
    if (!date) {
      return { error: 'Date is required in dd-mm-yyyy format' };
    }

    try {
      const response = await axios.get(`${this.baseURL}/coins/${coinId}/history`, {
        headers: this.headers,
        params: {
          date,
          localization: false
        }
      });

      const data = response.data;
      if (!data.market_data) {
        return { error: `No historical data found for ${coinId} on ${date}` };
      }

      return {
        id: data.id,
        symbol: data.symbol,
        name: data.name,
        date,
        marketData: {
          currentPrice: data.market_data.current_price.usd,
          marketCap: data.market_data.market_cap.usd,
          totalVolume: data.market_data.total_volume.usd
        }
      };
    } catch (error) {
      logger.error('CoinGecko historical data error:', error);
      return { error: 'Failed to fetch historical data' };
    }
  }

  formatNumber(num) {
    if (!num) return '0';
    
    if (num >= 1e9) {
      return `${(num / 1e9).toFixed(2)}B`;
    } else if (num >= 1e6) {
      return `${(num / 1e6).toFixed(2)}M`;
    } else if (num >= 1e3) {
      return `${(num / 1e3).toFixed(2)}K`;
    } else if (num < 1) {
      return num.toFixed(6);
    } else {
      return num.toFixed(2);
    }
  }

  formatResponse(response) {
    if (response.error) {
      return `❌ Error: ${response.error}`;
    }

    // Format based on the type of response
    if (response.formattedPrice) {
      // Price response
      return `💰 ${response.coin.toUpperCase()} Price: ${response.formattedPrice}
📊 24h Change: ${response.changePercent} ${response.change24h > 0 ? '📈' : '📉'}
💎 Market Cap: ${response.formattedMarketCap}
📈 24h Volume: ${response.formattedVolume}`;
    }

    if (response.trending) {
      // Trending response
      let result = '🔥 Trending Cryptocurrencies:\n\n';
      response.trending.forEach((coin, index) => {
        result += `${index + 1}. ${coin.name} (${coin.symbol.toUpperCase()}) - Rank #${coin.marketCapRank || 'N/A'}\n`;
      });
      return result;
    }

    if (response.results) {
      // Search response
      let result = `🔍 Search results for "${response.query}":\n\n`;
      response.results.forEach((coin, index) => {
        result += `${index + 1}. ${coin.name} (${coin.symbol.toUpperCase()}) - Rank #${coin.marketCapRank || 'N/A'}\n`;
      });
      return result;
    }

    if (response.exchanges) {
      // Exchanges response
      let result = '🏦 Top Cryptocurrency Exchanges:\n\n';
      response.exchanges.forEach((exchange, index) => {
        result += `${index + 1}. ${exchange.name} (${exchange.country || 'Global'})\n   Trust Score: ${exchange.trustScore}/10\n   24h Volume: ${this.formatNumber(exchange.tradeVolume24hBtc)} BTC\n\n`;
      });
      return result;
    }

    if (response.activeCryptocurrencies) {
      // Global data response
      return `🌍 Global Crypto Market Data:
      
📊 Active Cryptocurrencies: ${response.activeCryptocurrencies.toLocaleString()}
🏪 Markets: ${response.markets.toLocaleString()}
💰 Total Market Cap: $${this.formatNumber(response.totalMarketCap.usd)}
📈 24h Change: ${response.totalMarketCap.change24h.toFixed(2)}%
📊 24h Volume: $${this.formatNumber(response.totalVolume.usd)}

Top Market Share:
${response.marketCapPercentage.top10.map(({ coin, percentage }) => `• ${coin.toUpperCase()}: ${percentage}%`).join('\n')}`;
    }

    // Market data response
    if (response.marketCapRank) {
      return `📊 ${response.name} (${response.symbol.toUpperCase()}) Market Data:
      
💰 Price: $${response.currentPrice.usd.toLocaleString()}
📊 Market Cap Rank: #${response.marketCapRank}
💎 Market Cap: $${this.formatNumber(response.marketCap)}
📈 24h Volume: $${this.formatNumber(response.totalVolume)}
📊 24h Change: ${response.priceChangePercentage24h.toFixed(2)}%
📈 24h High: $${response.high24h.toLocaleString()}
📉 24h Low: $${response.low24h.toLocaleString()}
🔄 Circulating Supply: ${this.formatNumber(response.circulatingSupply)}
🚀 ATH: $${response.ath.usd.toLocaleString()} (${response.ath.changePercentage.toFixed(2)}%)
📉 ATL: $${response.atl.usd.toLocaleString()} (+${Math.abs(response.atl.changePercentage).toFixed(2)}%)`;
    }

    // Historical data response
    if (response.marketData) {
      return `📅 Historical Data for ${response.name} (${response.symbol.toUpperCase()}) on ${response.date}:
      
💰 Price: $${response.marketData.currentPrice.toLocaleString()}
💎 Market Cap: $${this.formatNumber(response.marketData.marketCap)}
📈 Total Volume: $${this.formatNumber(response.marketData.totalVolume)}`;
    }

    return JSON.stringify(response, null, 2);
  }

  async detectIntent(input) {
    const cryptoKeywords = [
      'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'cryptocurrency',
      'coin', 'token', 'price', 'market cap', 'volume', 'trading',
      'exchange', 'defi', 'altcoin', 'blockchain', 'coingecko'
    ];
    
    const lowerInput = input.toLowerCase();
    const hasCryptoKeyword = cryptoKeywords.some(keyword => lowerInput.includes(keyword));
    
    if (hasCryptoKeyword) {
      if (lowerInput.includes('price') || lowerInput.includes('cost') || lowerInput.includes('worth')) {
        return { action: 'price', confidence: 0.9 };
      } else if (lowerInput.includes('trending') || lowerInput.includes('popular')) {
        return { action: 'trending', confidence: 0.9 };
      } else if (lowerInput.includes('search') || lowerInput.includes('find')) {
        return { action: 'search', confidence: 0.8 };
      } else if (lowerInput.includes('exchange')) {
        return { action: 'exchanges', confidence: 0.8 };
      } else if (lowerInput.includes('global') || lowerInput.includes('market')) {
        return { action: 'global', confidence: 0.7 };
      } else if (lowerInput.includes('data') || lowerInput.includes('info')) {
        return { action: 'marketData', confidence: 0.7 };
      } else if (lowerInput.includes('historical') || lowerInput.includes('past')) {
        return { action: 'historicalData', confidence: 0.8 };
      }
      
      return { action: 'price', confidence: 0.6 };
    }
    
    return null;
  }
}