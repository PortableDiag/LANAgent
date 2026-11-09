import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

/**
 * Alpha Vantage Stock Market Data Plugin
 * 
 * Provides access to real-time and historical stock market data
 * 
 * Usage Examples:
 * - Natural language: "get AAPL stock price from alpha vantage"
 * - Command format: api alphavantage quote AAPL
 * - Telegram: Just type naturally about stocks
 */
export default class AlphaVantagePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'alphavantage';
    this.version = '1.0.0';
    this.description = 'Stock market data API';
    this.category = 'data';
    this.commands = [
      {
        command: 'quote',
        description: 'Get real-time stock quote',
        usage: 'quote [symbol]'
      },
      {
        command: 'daily',
        description: 'Get daily time series data',
        usage: 'daily [symbol] [outputsize]'
      },
      {
        command: 'search',
        description: 'Search for stock symbols',
        usage: 'search [keywords]'
      },
      {
        command: 'overview',
        description: 'Get company overview and fundamentals',
        usage: 'overview [symbol]'
      },
      {
        command: 'forex',
        description: 'Get foreign exchange rate',
        usage: 'forex [from_currency] [to_currency]'
      },
      {
        command: 'crypto',
        description: 'Get cryptocurrency exchange rate',
        usage: 'crypto [symbol] [market]'
      }
    ];
    
    // API configuration
    this.apiKey = process.env.ALPHA_VANTAGE_API_KEY || process.env.ALPHAVANTAGE_API_KEY || '';
    this.baseURL = 'https://www.alphavantage.co/query';
  }

  async execute(action, params = {}) {
    // Callers pass one object ({ action, ...params }); the two-argument form saw an object as the action.
    if (action && typeof action === 'object') { params = { ...action }; action = params.action; }
    try {
      logger.info(`Executing ${this.name}.${action} with params:`, params);
      
      if (!this.apiKey) {
        return await this.keyless(action, params);
      }

      const viaKey = await this.withKey(action, params);
      // Alpha Vantage's free tier is 25 calls a day; past that (or on any failure) the keyless sources answer.
      if (viaKey?.error && action !== 'overview' && /limit|Failed|No data|Invalid API/i.test(viaKey.error)) {
        const alt = await this.keyless(action, params);
        if (!alt.error) return alt;
      }
      return viaKey;
    } catch (error) {
      logger.error(`Error in ${this.name}.${action}:`, error);
      return { error: error.message || 'An error occurred' };
    }
  }

  async withKey(action, params) {
    try {
      switch (action) {
        case 'quote':
          return await this.getQuote(params);
        case 'daily':
          return await this.getDailyTimeSeries(params);
        case 'search':
          return await this.searchSymbol(params);
        case 'overview':
          return await this.getCompanyOverview(params);
        case 'forex':
          return await this.getForexRate(params);
        case 'crypto':
          return await this.getCryptoRate(params);
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (error) {
      logger.error(`Error in ${this.name}.${action}:`, error);
      return { error: error.message || 'An error occurred' };
    }
  }

  async getQuote({ symbol }) {
    if (!symbol) {
      return { error: 'Stock symbol is required' };
    }

    try {
      const response = await axios.get(this.baseURL, {
        params: {
          function: 'GLOBAL_QUOTE',
          symbol: symbol.toUpperCase(),
          apikey: this.apiKey
        }
      });

      if (response.data['Error Message']) {
        return { error: 'Invalid API call or symbol not found' };
      }

      if (response.data['Note']) {
        return { error: 'API call frequency limit reached. Please try again later.' };
      }

      const quote = response.data['Global Quote'];
      if (!quote || Object.keys(quote).length === 0) {
        return { error: `No data found for symbol ${symbol}` };
      }

      return {
        symbol: quote['01. symbol'],
        price: parseFloat(quote['05. price']),
        open: parseFloat(quote['02. open']),
        high: parseFloat(quote['03. high']),
        low: parseFloat(quote['04. low']),
        volume: parseInt(quote['06. volume']),
        latestTradingDay: quote['07. latest trading day'],
        previousClose: parseFloat(quote['08. previous close']),
        change: parseFloat(quote['09. change']),
        changePercent: quote['10. change percent'],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Alpha Vantage quote error:', error);
      return { error: 'Failed to fetch quote data' };
    }
  }

  async getDailyTimeSeries({ symbol, outputsize = 'compact' }) {
    if (!symbol) {
      return { error: 'Stock symbol is required' };
    }

    try {
      const response = await axios.get(this.baseURL, {
        params: {
          function: 'TIME_SERIES_DAILY',
          symbol: symbol.toUpperCase(),
          outputsize, // 'compact' (100 days) or 'full' (20+ years)
          apikey: this.apiKey
        }
      });

      if (response.data['Error Message']) {
        return { error: 'Invalid API call or symbol not found' };
      }

      if (response.data['Note']) {
        return { error: 'API call frequency limit reached. Please try again later.' };
      }

      const metadata = response.data['Meta Data'];
      const timeSeries = response.data['Time Series (Daily)'];

      if (!timeSeries) {
        return { error: `No data found for symbol ${symbol}` };
      }

      // Convert to array and sort by date
      const dailyData = Object.entries(timeSeries)
        .map(([date, values]) => ({
          date,
          open: parseFloat(values['1. open']),
          high: parseFloat(values['2. high']),
          low: parseFloat(values['3. low']),
          close: parseFloat(values['4. close']),
          volume: parseInt(values['5. volume'])
        }))
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, outputsize === 'compact' ? 100 : 1000);

      return {
        symbol: metadata['2. Symbol'],
        lastRefreshed: metadata['3. Last Refreshed'],
        outputSize: metadata['4. Output Size'],
        timezone: metadata['5. Time Zone'],
        dailyData,
        dataPoints: dailyData.length
      };
    } catch (error) {
      logger.error('Alpha Vantage daily time series error:', error);
      return { error: 'Failed to fetch time series data' };
    }
  }

  async searchSymbol({ keywords }) {
    if (!keywords) {
      return { error: 'Search keywords are required' };
    }

    try {
      const response = await axios.get(this.baseURL, {
        params: {
          function: 'SYMBOL_SEARCH',
          keywords,
          apikey: this.apiKey
        }
      });

      if (response.data['Error Message']) {
        return { error: 'Invalid API call' };
      }

      if (response.data['Note']) {
        return { error: 'API call frequency limit reached. Please try again later.' };
      }

      const matches = response.data['bestMatches'] || [];

      return {
        keywords,
        matches: matches.map(match => ({
          symbol: match['1. symbol'],
          name: match['2. name'],
          type: match['3. type'],
          region: match['4. region'],
          marketOpen: match['5. marketOpen'],
          marketClose: match['6. marketClose'],
          timezone: match['7. timezone'],
          currency: match['8. currency'],
          matchScore: parseFloat(match['9. matchScore'])
        })),
        count: matches.length
      };
    } catch (error) {
      logger.error('Alpha Vantage search error:', error);
      return { error: 'Failed to search symbols' };
    }
  }

  async getCompanyOverview({ symbol }) {
    if (!symbol) {
      return { error: 'Stock symbol is required' };
    }

    try {
      const response = await axios.get(this.baseURL, {
        params: {
          function: 'OVERVIEW',
          symbol: symbol.toUpperCase(),
          apikey: this.apiKey
        }
      });

      if (response.data['Error Message']) {
        return { error: 'Invalid API call or symbol not found' };
      }

      if (response.data['Note']) {
        return { error: 'API call frequency limit reached. Please try again later.' };
      }

      const overview = response.data;
      
      if (!overview || Object.keys(overview).length === 0) {
        return { error: `No overview data found for symbol ${symbol}` };
      }

      return {
        symbol: overview.Symbol,
        name: overview.Name,
        description: overview.Description,
        exchange: overview.Exchange,
        currency: overview.Currency,
        country: overview.Country,
        sector: overview.Sector,
        industry: overview.Industry,
        address: overview.Address,
        marketCapitalization: parseInt(overview.MarketCapitalization),
        peRatio: parseFloat(overview.PERatio),
        pegRatio: parseFloat(overview.PEGRatio),
        bookValue: parseFloat(overview.BookValue),
        dividendPerShare: parseFloat(overview.DividendPerShare),
        dividendYield: parseFloat(overview.DividendYield),
        eps: parseFloat(overview.EPS),
        revenuePerShareTTM: parseFloat(overview.RevenuePerShareTTM),
        profitMargin: parseFloat(overview.ProfitMargin),
        operatingMarginTTM: parseFloat(overview.OperatingMarginTTM),
        returnOnAssetsTTM: parseFloat(overview.ReturnOnAssetsTTM),
        returnOnEquityTTM: parseFloat(overview.ReturnOnEquityTTM),
        revenueTTM: parseInt(overview.RevenueTTM),
        grossProfitTTM: parseInt(overview.GrossProfitTTM),
        dilutedEPSTTM: parseFloat(overview.DilutedEPSTTM),
        quarterlyEarningsGrowthYOY: parseFloat(overview.QuarterlyEarningsGrowthYOY),
        quarterlyRevenueGrowthYOY: parseFloat(overview.QuarterlyRevenueGrowthYOY),
        analystTargetPrice: parseFloat(overview.AnalystTargetPrice),
        trailingPE: parseFloat(overview.TrailingPE),
        forwardPE: parseFloat(overview.ForwardPE),
        priceToSalesRatioTTM: parseFloat(overview.PriceToSalesRatioTTM),
        priceToBookRatio: parseFloat(overview.PriceToBookRatio),
        week52High: parseFloat(overview['52WeekHigh']),
        week52Low: parseFloat(overview['52WeekLow']),
        movingAverage50Day: parseFloat(overview['50DayMovingAverage']),
        movingAverage200Day: parseFloat(overview['200DayMovingAverage']),
        sharesOutstanding: parseInt(overview.SharesOutstanding),
        dividendDate: overview.DividendDate,
        exDividendDate: overview.ExDividendDate
      };
    } catch (error) {
      logger.error('Alpha Vantage company overview error:', error);
      return { error: 'Failed to fetch company overview' };
    }
  }

  async getForexRate({ from_currency, to_currency }) {
    if (!from_currency || !to_currency) {
      return { error: 'Both from_currency and to_currency are required' };
    }

    try {
      const response = await axios.get(this.baseURL, {
        params: {
          function: 'CURRENCY_EXCHANGE_RATE',
          from_currency: from_currency.toUpperCase(),
          to_currency: to_currency.toUpperCase(),
          apikey: this.apiKey
        }
      });

      if (response.data['Error Message']) {
        return { error: 'Invalid API call or currency codes not found' };
      }

      if (response.data['Note']) {
        return { error: 'API call frequency limit reached. Please try again later.' };
      }

      const forexData = response.data['Realtime Currency Exchange Rate'];
      
      if (!forexData) {
        return { error: 'No forex data found for the specified currency pair' };
      }

      return {
        fromCurrencyCode: forexData['1. From_Currency Code'],
        fromCurrencyName: forexData['2. From_Currency Name'],
        toCurrencyCode: forexData['3. To_Currency Code'],
        toCurrencyName: forexData['4. To_Currency Name'],
        exchangeRate: parseFloat(forexData['5. Exchange Rate']),
        lastRefreshed: forexData['6. Last Refreshed'],
        timezone: forexData['7. Time Zone'],
        bidPrice: parseFloat(forexData['8. Bid Price']),
        askPrice: parseFloat(forexData['9. Ask Price'])
      };
    } catch (error) {
      logger.error('Alpha Vantage forex error:', error);
      return { error: 'Failed to fetch forex data' };
    }
  }

  async getCryptoRate({ symbol = 'BTC', market = 'USD' }) {
    try {
      const response = await axios.get(this.baseURL, {
        params: {
          function: 'CURRENCY_EXCHANGE_RATE',
          from_currency: symbol.toUpperCase(),
          to_currency: market.toUpperCase(),
          apikey: this.apiKey
        }
      });

      if (response.data['Error Message']) {
        return { error: 'Invalid API call or crypto symbol not found' };
      }

      if (response.data['Note']) {
        return { error: 'API call frequency limit reached. Please try again later.' };
      }

      const cryptoData = response.data['Realtime Currency Exchange Rate'];
      
      if (!cryptoData) {
        return { error: 'No crypto data found for the specified pair' };
      }

      return {
        fromCurrency: cryptoData['1. From_Currency Code'],
        fromCurrencyName: cryptoData['2. From_Currency Name'],
        toCurrency: cryptoData['3. To_Currency Code'],
        toCurrencyName: cryptoData['4. To_Currency Name'],
        exchangeRate: parseFloat(cryptoData['5. Exchange Rate']),
        lastRefreshed: cryptoData['6. Last Refreshed'],
        timezone: cryptoData['7. Time Zone'],
        bidPrice: parseFloat(cryptoData['8. Bid Price']),
        askPrice: parseFloat(cryptoData['9. Ask Price'])
      };
    } catch (error) {
      logger.error('Alpha Vantage crypto error:', error);
      return { error: 'Failed to fetch crypto data' };
    }
  }

  /**
   * Market data with no Alpha Vantage key (ALICE had none on 2026-11-09, so every call failed): Yahoo Finance's public
   * chart and search endpoints for stocks and crypto, Frankfurter (ECB rates) for currencies. Same shapes as above.
   */
  async keyless(action, params = {}) {
    const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) LANAgent/1.0', Accept: 'application/json' };
    const chart = async (sym, range, interval = '1d') => {
      const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`, { params: { range, interval }, headers: UA, timeout: 15000 });
      const res = r.data?.chart?.result?.[0];
      if (!res) throw new Error(r.data?.chart?.error?.description || `No data found for symbol ${sym}`);
      const q = res.indicators?.quote?.[0] || {};
      const rows = (res.timestamp || []).map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] }))
        .filter(x => x.close != null);
      return { meta: res.meta, rows };
    };
    try {
      if (action === 'quote') {
        if (!params.symbol) return { error: 'Stock symbol is required' };
        const { meta, rows } = await chart(params.symbol.toUpperCase(), '5d');
        const last = rows[rows.length - 1] || {};
        const prev = rows.length > 1 ? rows[rows.length - 2].close : meta.chartPreviousClose;
        const price = meta.regularMarketPrice ?? last.close;
        const change = prev != null ? price - prev : null;
        return { symbol: meta.symbol, price, open: last.open, high: meta.regularMarketDayHigh ?? last.high, low: meta.regularMarketDayLow ?? last.low,
          volume: meta.regularMarketVolume ?? last.volume, latestTradingDay: last.date, previousClose: prev,
          change, changePercent: change != null && prev ? `${((change / prev) * 100).toFixed(4)}%` : null, currency: meta.currency,
          timestamp: new Date().toISOString(), source: 'yahoo' };
      }
      if (action === 'daily') {
        if (!params.symbol) return { error: 'Stock symbol is required' };
        const full = params.outputsize === 'full';
        const { meta, rows } = await chart(params.symbol.toUpperCase(), full ? '5y' : '6mo');
        const dailyData = rows.reverse().slice(0, full ? 1000 : 100);
        return { symbol: meta.symbol, lastRefreshed: dailyData[0]?.date, outputSize: full ? 'Full size' : 'Compact', timezone: meta.exchangeTimezoneName,
          dailyData, dataPoints: dailyData.length, source: 'yahoo' };
      }
      if (action === 'search') {
        if (!params.keywords) return { error: 'Search keywords are required' };
        const r = await axios.get('https://query1.finance.yahoo.com/v1/finance/search', { params: { q: params.keywords, quotesCount: 10, newsCount: 0 }, headers: UA, timeout: 15000 });
        const matches = (r.data?.quotes || []).filter(q => q.symbol).map(q => ({ symbol: q.symbol, name: q.longname || q.shortname, type: q.typeDisp || q.quoteType, region: q.exchDisp, currency: null, matchScore: null }));
        return { keywords: params.keywords, matches, count: matches.length, source: 'yahoo' };
      }
      if (action === 'forex') {
        const { from_currency: f, to_currency: to } = params;
        if (!f || !to) return { error: 'Both from_currency and to_currency are required' };
        const r = await axios.get('https://api.frankfurter.dev/v1/latest', { params: { base: f.toUpperCase(), symbols: to.toUpperCase() }, timeout: 15000 });
        const rate = r.data?.rates?.[to.toUpperCase()];
        if (rate == null) return { error: 'No forex data found for the specified currency pair' };
        return { fromCurrencyCode: f.toUpperCase(), toCurrencyCode: to.toUpperCase(), exchangeRate: rate, lastRefreshed: r.data.date, timezone: 'UTC (ECB reference rate)', source: 'frankfurter' };
      }
      if (action === 'crypto') {
        const sym = String(params.symbol || 'BTC').toUpperCase(), market = String(params.market || 'USD').toUpperCase();
        const { meta } = await chart(`${sym}-${market}`, '1d', '5m');
        return { fromCurrency: sym, toCurrency: market, exchangeRate: meta.regularMarketPrice, lastRefreshed: new Date((meta.regularMarketTime || Date.now() / 1000) * 1000).toISOString(), timezone: 'UTC', source: 'yahoo' };
      }
      if (action === 'overview') return { error: 'Company overview needs an Alpha Vantage API key (set ALPHA_VANTAGE_API_KEY); quote, daily, search, forex and crypto work without one' };
      return { error: `Unknown action: ${action}` };
    } catch (error) {
      logger.error(`Keyless ${action} failed:`, error.message);
      return { error: error.response?.status === 404 ? `No data found for symbol ${params.symbol}` : `Market data unavailable: ${error.message}` };
    }
  }

  formatResponse(response) {
    if (response.error) {
      return `❌ Error: ${response.error}`;
    }

    // Quote response
    if (response.symbol && response.price !== undefined) {
      return `📊 ${response.symbol} Stock Quote:
💰 Price: $${response.price.toFixed(2)}
📈 Change: ${response.change.toFixed(2)} (${response.changePercent})
📊 Open: $${response.open.toFixed(2)}
📈 High: $${response.high.toFixed(2)}
📉 Low: $${response.low.toFixed(2)}
📊 Volume: ${response.volume.toLocaleString()}
📅 Trading Day: ${response.latestTradingDay}
📊 Previous Close: $${response.previousClose.toFixed(2)}`;
    }

    // Search response
    if (response.matches) {
      let result = `🔍 Symbol Search Results for "${response.keywords}":\n\n`;
      response.matches.forEach((match, index) => {
        result += `${index + 1}. ${match.symbol} - ${match.name}\n`;
        result += `   Type: ${match.type} | Region: ${match.region}\n`;
        result += `   Currency: ${match.currency} | Score: ${match.matchScore}\n\n`;
      });
      return result;
    }

    // Company overview response
    if (response.description) {
      return `🏢 ${response.name} (${response.symbol}) Company Overview:

📝 ${response.description.substring(0, 200)}...

📊 Market Data:
• Market Cap: $${this.formatNumber(response.marketCapitalization)}
• P/E Ratio: ${response.peRatio || 'N/A'}
• Dividend Yield: ${response.dividendYield ? `${(response.dividendYield * 100).toFixed(2)}%` : 'N/A'}
• 52 Week High: $${response.week52High?.toFixed(2) || 'N/A'}
• 52 Week Low: $${response.week52Low?.toFixed(2) || 'N/A'}

🏭 Business Info:
• Sector: ${response.sector}
• Industry: ${response.industry}
• Country: ${response.country}
• Exchange: ${response.exchange}`;
    }

    // Forex/Crypto response
    if (response.exchangeRate !== undefined) {
      return `💱 ${response.fromCurrencyCode || response.fromCurrency} to ${response.toCurrencyCode || response.toCurrency}:
📊 Exchange Rate: ${response.exchangeRate}
💵 Bid Price: ${response.bidPrice}
💵 Ask Price: ${response.askPrice}
📅 Last Updated: ${response.lastRefreshed}
🌍 Timezone: ${response.timezone}`;
    }

    // Time series response
    if (response.dailyData) {
      const latest = response.dailyData[0];
      return `📈 ${response.symbol} Daily Time Series:
📅 Last Refreshed: ${response.lastRefreshed}
📊 Latest Close: $${latest.close.toFixed(2)}
📊 Data Points: ${response.dataPoints}

Recent Trading Days:
${response.dailyData.slice(0, 5).map(day => 
  `${day.date}: Close $${day.close.toFixed(2)} | Volume: ${day.volume.toLocaleString()}`
).join('\n')}`;
    }

    return JSON.stringify(response, null, 2);
  }

  formatNumber(num) {
    if (!num) return 'N/A';
    
    if (num >= 1e12) {
      return `${(num / 1e12).toFixed(2)}T`;
    } else if (num >= 1e9) {
      return `${(num / 1e9).toFixed(2)}B`;
    } else if (num >= 1e6) {
      return `${(num / 1e6).toFixed(2)}M`;
    } else if (num >= 1e3) {
      return `${(num / 1e3).toFixed(2)}K`;
    }
    return num.toFixed(2);
  }

  async detectIntent(input) {
    const stockKeywords = [
      'stock', 'share', 'equity', 'ticker', 'symbol',
      'price', 'quote', 'market', 'trading', 'nasdaq',
      'nyse', 'dow', 's&p', 'alpha vantage', 'alphavantage'
    ];
    
    const forexKeywords = ['forex', 'currency', 'exchange rate', 'fx'];
    const cryptoKeywords = ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth'];
    
    const lowerInput = input.toLowerCase();
    const hasStockKeyword = stockKeywords.some(keyword => lowerInput.includes(keyword));
    const hasForexKeyword = forexKeywords.some(keyword => lowerInput.includes(keyword));
    const hasCryptoKeyword = cryptoKeywords.some(keyword => lowerInput.includes(keyword));
    
    if (hasStockKeyword || hasForexKeyword || hasCryptoKeyword) {
      if (lowerInput.includes('search') || lowerInput.includes('find')) {
        return { action: 'search', confidence: 0.8 };
      }
      
      if (hasForexKeyword) {
        return { action: 'forex', confidence: 0.9 };
      }
      
      if (hasCryptoKeyword) {
        return { action: 'crypto', confidence: 0.9 };
      }
      
      if (lowerInput.includes('overview') || lowerInput.includes('company') || lowerInput.includes('fundamental')) {
        return { action: 'overview', confidence: 0.8 };
      }
      
      if (lowerInput.includes('daily') || lowerInput.includes('history') || lowerInput.includes('chart')) {
        return { action: 'daily', confidence: 0.7 };
      }
      
      // Default to quote for stock-related queries
      return { action: 'quote', confidence: 0.9 };
    }
    
    return null;
  }
}