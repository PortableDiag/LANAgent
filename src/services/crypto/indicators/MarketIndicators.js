/**
 * Market Indicators
 *
 * Market-wide indicators for rule-based strategies.
 * Includes fear/greed index, gas prices, market cap, etc.
 */

import NodeCache from 'node-cache';
import { logger as baseLogger } from '../../../utils/logger.js';
import { retryOperation } from '../../../utils/retryUtils.js';

const logger = baseLogger.child ? baseLogger.child({ service: 'market-indicators' }) : baseLogger;

export class MarketIndicators {
  constructor() {
    this.indicators = new Map();
    this.metadataMap = new Map();
    this.historicalData = new Map();
    this.maxHistoryPoints = 1000;

    // Cache for external API calls
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

    this.registerIndicators();
  }

  /**
   * Get cached value or fetch new
   */
  async getCachedValue(key, fetcher) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const value = await retryOperation(fetcher);
      this.cache.set(key, value);
      return value;
    } catch (error) {
      logger.warn(`Failed to fetch ${key}: ${error.message}`);
      // Return cached value even if stale, or default
      return cached ?? null;
    }
  }

  /**
   * Fetch multiple cached values concurrently
   * @param {string[]} keys - Cache keys
   * @param {Function[]} fetchers - Corresponding fetcher functions
   * @returns {Promise<any[]>}
   */
  async getCachedValues(keys, fetchers) {
    return Promise.all(keys.map((key, index) => this.getCachedValue(key, fetchers[index])));
  }

  /**
   * Store a historical data point for a market indicator
   */
  storeHistoricalData(indicator, value) {
    if (!this.historicalData.has(indicator)) {
      this.historicalData.set(indicator, []);
    }
    const data = this.historicalData.get(indicator);
    data.push({ timestamp: Date.now(), value });
    // Trim to prevent unbounded memory growth
    if (data.length > this.maxHistoryPoints) {
      data.splice(0, data.length - this.maxHistoryPoints);
    }
  }

  /**
   * Calculate simple moving average for a market indicator
   */
  calculateMovingAverage(indicator, period) {
    const data = this.historicalData.get(indicator);
    if (!data || data.length < period) return null;
    const recentData = data.slice(-period);
    return recentData.reduce((acc, point) => acc + point.value, 0) / period;
  }

  /**
   * Calculate volatility (standard deviation) for a market indicator
   */
  calculateVolatility(indicator, period) {
    const data = this.historicalData.get(indicator);
    if (!data || data.length < period) return null;
    const recentData = data.slice(-period);
    const mean = recentData.reduce((acc, point) => acc + point.value, 0) / period;
    const variance = recentData.reduce((acc, point) => acc + Math.pow(point.value - mean, 2), 0) / period;
    return Math.sqrt(variance);
  }

  registerIndicators() {
    // Fear & Greed Index (0-100, 0 = extreme fear, 100 = extreme greed)
    // Note: Would need external API integration for real data
    this.register('fear_greed_index', async (ctx) => {
      const value = await this.getCachedValue('fear_greed', async () => {
        // In production, fetch from Alternative.me API or similar
        // For now, return a mock value based on 24h change
        const change24h = ctx.marketData?.prices?.['ethereum']?.change24h || 0;

        // Simple heuristic: map -10% to +10% change to 0-100 scale
        const scaled = Math.max(0, Math.min(100, 50 + (change24h * 5)));
        return Math.round(scaled);
      });
      this.storeHistoricalData('fear_greed_index', value);
      return value;
    }, {
      type: 'number',
      description: 'Crypto Fear & Greed Index (0-100)',
      category: 'market'
    });

    // Bitcoin dominance
    this.register('btc_dominance', async (ctx) => {
      const value = await this.getCachedValue('btc_dominance', async () => {
        // Would fetch from CoinGecko or similar
        // Default to typical value
        return 50;
      });
      this.storeHistoricalData('btc_dominance', value);
      return value;
    }, {
      type: 'number',
      description: 'Bitcoin market dominance percentage',
      category: 'market'
    });

    // Gas price (Ethereum mainnet, in gwei)
    this.register('gas_price_gwei', async (ctx) => {
      const value = ctx.marketData?.gas?.ethereum || 30;
      this.storeHistoricalData('gas_price_gwei', value);
      return value;
    }, {
      type: 'number',
      description: 'Ethereum gas price in gwei',
      category: 'market'
    });

    // Gas price (BSC)
    this.register('gas_price_bsc', async (ctx) => {
      const value = ctx.marketData?.gas?.bsc || 3;
      this.storeHistoricalData('gas_price_bsc', value);
      return value;
    }, {
      type: 'number',
      description: 'BSC gas price in gwei',
      category: 'market'
    });

    // Is gas cheap (relative to recent average)
    this.register('is_gas_cheap', async (ctx) => {
      const gasPrice = ctx.marketData?.gas?.ethereum || 30;
      return gasPrice < 25; // Arbitrary threshold
    }, {
      type: 'boolean',
      description: 'True if Ethereum gas is below average',
      category: 'market'
    });

    // Volume indicators (would need exchange data)
    this.register('volume_24h', async (ctx) => {
      const value = ctx.marketData?.volume?.[ctx.network] || 0;
      this.storeHistoricalData('volume_24h', value);
      return value;
    }, {
      type: 'number',
      description: '24-hour trading volume in USD',
      category: 'market'
    });

    this.register('volume_change_24h', async (ctx) => {
      const value = ctx.marketData?.volumeChange?.[ctx.network] || 0;
      this.storeHistoricalData('volume_change_24h', value);
      return value;
    }, {
      type: 'number',
      description: '24-hour volume change percentage',
      category: 'market'
    });

    // Market regime (based on multiple factors)
    this.register('market_regime', async (ctx) => {
      const change24h = ctx.marketData?.prices?.[ctx.network]?.change24h || 0;
      const change7d = ctx.marketData?.prices?.[ctx.network]?.change7d || 0;

      if (change24h > 5 && change7d > 10) return 'bull';
      if (change24h < -5 && change7d < -10) return 'bear';
      if (Math.abs(change24h) < 2 && Math.abs(change7d) < 5) return 'sideways';
      if (change24h > 3) return 'bullish';
      if (change24h < -3) return 'bearish';
      return 'neutral';
    }, {
      type: 'string',
      description: 'Market regime (bull, bear, sideways, bullish, bearish, neutral)',
      category: 'market'
    });

    // Is bull market
    this.register('is_bull_market', async (ctx) => {
      const change7d = ctx.marketData?.prices?.[ctx.network]?.change7d || 0;
      const change24h = ctx.marketData?.prices?.[ctx.network]?.change24h || 0;
      return change7d > 5 && change24h > 0;
    }, {
      type: 'boolean',
      description: 'True if in apparent bull market',
      category: 'market'
    });

    // Is bear market
    this.register('is_bear_market', async (ctx) => {
      const change7d = ctx.marketData?.prices?.[ctx.network]?.change7d || 0;
      const change24h = ctx.marketData?.prices?.[ctx.network]?.change24h || 0;
      return change7d < -5 && change24h < 0;
    }, {
      type: 'boolean',
      description: 'True if in apparent bear market',
      category: 'market'
    });

    // Network-specific
    this.register('network', async (ctx) => {
      return ctx.network || 'unknown';
    }, {
      type: 'string',
      description: 'Current network being evaluated',
      category: 'market'
    });

    this.register('asset', async (ctx) => {
      return ctx.asset || 'unknown';
    }, {
      type: 'string',
      description: 'Current asset being evaluated',
      category: 'market'
    });

    this.register('network_mode', async (ctx) => {
      return ctx.networkMode || 'testnet';
    }, {
      type: 'string',
      description: 'Network mode (testnet or mainnet)',
      category: 'market'
    });
  }

  register(name, fn, metadata) {
    this.indicators.set(name, fn);
    this.metadataMap.set(name, metadata);
  }

  getIndicators() {
    return this.indicators;
  }

  getMetadata(name) {
    return this.metadataMap.get(name);
  }
}

export default MarketIndicators;
