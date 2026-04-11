/**
 * Technical Indicators
 *
 * Technical analysis indicators for rule-based strategies.
 * Note: Some indicators require historical price data in context.
 */

export class TechnicalIndicators {
  constructor() {
    this.indicators = new Map();
    this.metadataMap = new Map();
    this.registerIndicators();
  }

  /**
   * Calculate Simple Moving Average
   */
  calculateSMA(prices, period) {
    if (!prices || prices.length < period) return null;
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  /**
   * Calculate Exponential Moving Average
   */
  calculateEMA(prices, period) {
    if (!prices || prices.length < period) return null;

    const multiplier = 2 / (period + 1);
    let ema = this.calculateSMA(prices.slice(0, period), period);

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  calculateRSI(prices, period = 14) {
    if (!prices || prices.length < period + 1) return 50; // Neutral default

    const changes = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    const gains = changes.map(c => c > 0 ? c : 0);
    const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);

    const recentGains = gains.slice(-period);
    const recentLosses = losses.slice(-period);

    const avgGain = recentGains.reduce((a, b) => a + b, 0) / period;
    const avgLoss = recentLosses.reduce((a, b) => a + b, 0) / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate MACD
   */
  calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (!prices || prices.length < slowPeriod) {
      return { macd: 0, signal: 0, histogram: 0 };
    }

    // Compute MACD line for enough data points to calculate signal EMA
    const macdValues = [];
    const minLen = slowPeriod + signalPeriod;
    const startIdx = Math.max(slowPeriod, prices.length - minLen);

    for (let i = startIdx; i <= prices.length; i++) {
      const slice = prices.slice(0, i);
      const fast = this.calculateEMA(slice, fastPeriod);
      const slow = this.calculateEMA(slice, slowPeriod);
      if (fast !== null && slow !== null) {
        macdValues.push(fast - slow);
      }
    }

    const macd = macdValues[macdValues.length - 1] || 0;

    // Signal line = EMA of MACD values
    let signal = 0;
    if (macdValues.length >= signalPeriod) {
      const multiplier = 2 / (signalPeriod + 1);
      signal = macdValues.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
      for (let i = signalPeriod; i < macdValues.length; i++) {
        signal = (macdValues[i] - signal) * multiplier + signal;
      }
    }

    return { macd, signal, histogram: macd - signal };
  }

  /**
   * Calculate Bollinger Bands
   */
  calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
    if (!prices || prices.length < period) {
      return { upper: 0, middle: 0, lower: 0 };
    }

    const slice = prices.slice(-period);
    const middle = slice.reduce((a, b) => a + b, 0) / period;

    const squaredDiffs = slice.map(p => Math.pow(p - middle, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
      upper: middle + (stdDev * stdDevMultiplier),
      middle,
      lower: middle - (stdDev * stdDevMultiplier)
    };
  }

  registerIndicators() {
    // RSI (14-period default)
    this.register('rsi', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateRSI(prices, 14);
    }, {
      type: 'number',
      description: 'Relative Strength Index (0-100)',
      category: 'technical'
    });

    this.register('rsi_14', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateRSI(prices, 14);
    }, {
      type: 'number',
      description: '14-period RSI',
      category: 'technical'
    });

    this.register('rsi_7', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateRSI(prices, 7);
    }, {
      type: 'number',
      description: '7-period RSI (more sensitive)',
      category: 'technical'
    });

    // Moving Averages
    this.register('ma_20', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateSMA(prices, 20) || ctx.marketData?.prices?.[ctx.network]?.price || 0;
    }, {
      type: 'number',
      description: '20-period Simple Moving Average',
      category: 'technical'
    });

    this.register('ma_50', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateSMA(prices, 50) || ctx.marketData?.prices?.[ctx.network]?.price || 0;
    }, {
      type: 'number',
      description: '50-period Simple Moving Average',
      category: 'technical'
    });

    this.register('ma_200', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateSMA(prices, 200) || ctx.marketData?.prices?.[ctx.network]?.price || 0;
    }, {
      type: 'number',
      description: '200-period Simple Moving Average',
      category: 'technical'
    });

    // EMAs
    this.register('ema_12', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateEMA(prices, 12) || ctx.marketData?.prices?.[ctx.network]?.price || 0;
    }, {
      type: 'number',
      description: '12-period Exponential Moving Average',
      category: 'technical'
    });

    this.register('ema_26', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateEMA(prices, 26) || ctx.marketData?.prices?.[ctx.network]?.price || 0;
    }, {
      type: 'number',
      description: '26-period Exponential Moving Average',
      category: 'technical'
    });

    // Price vs MA
    this.register('price_vs_ma_20', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      const ma = this.calculateSMA(prices, 20);
      if (!ma) return 0;
      const price = ctx.marketData?.prices?.[ctx.network]?.price || 0;
      return ((price - ma) / ma) * 100;
    }, {
      type: 'number',
      description: 'Current price vs 20-period MA (%)',
      category: 'technical'
    });

    this.register('price_vs_ma_50', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      const ma = this.calculateSMA(prices, 50);
      if (!ma) return 0;
      const price = ctx.marketData?.prices?.[ctx.network]?.price || 0;
      return ((price - ma) / ma) * 100;
    }, {
      type: 'number',
      description: 'Current price vs 50-period MA (%)',
      category: 'technical'
    });

    // MACD
    this.register('macd', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateMACD(prices).macd;
    }, {
      type: 'number',
      description: 'MACD line value',
      category: 'technical'
    });

    this.register('macd_histogram', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateMACD(prices).histogram;
    }, {
      type: 'number',
      description: 'MACD histogram',
      category: 'technical'
    });

    // Bollinger Bands
    this.register('bollinger_upper', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateBollingerBands(prices).upper;
    }, {
      type: 'number',
      description: 'Upper Bollinger Band',
      category: 'technical'
    });

    this.register('bollinger_lower', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateBollingerBands(prices).lower;
    }, {
      type: 'number',
      description: 'Lower Bollinger Band',
      category: 'technical'
    });

    this.register('bollinger_middle', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      return this.calculateBollingerBands(prices).middle;
    }, {
      type: 'number',
      description: 'Middle Bollinger Band (20-period SMA)',
      category: 'technical'
    });

    // Price position in Bollinger Bands (0-100, 50 = middle)
    this.register('bollinger_position', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      const bands = this.calculateBollingerBands(prices);
      if (bands.upper === bands.lower) return 50;

      const price = ctx.marketData?.prices?.[ctx.network]?.price || 0;
      const position = ((price - bands.lower) / (bands.upper - bands.lower)) * 100;
      return Math.max(0, Math.min(100, position));
    }, {
      type: 'number',
      description: 'Price position within Bollinger Bands (0-100)',
      category: 'technical'
    });

    // Volatility (standard deviation of returns)
    this.register('volatility', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      if (prices.length < 2) return 0;

      const returns = [];
      for (let i = 1; i < prices.length; i++) {
        returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
      }

      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const squaredDiffs = returns.map(r => Math.pow(r - mean, 2));
      const variance = squaredDiffs.reduce((a, b) => a + b, 0) / returns.length;

      return Math.sqrt(variance) * 100; // Return as percentage
    }, {
      type: 'number',
      description: 'Price volatility (std dev of returns, %)',
      category: 'technical'
    });

    // Trend direction (based on MA crossover)
    this.register('trend', async (ctx) => {
      const prices = ctx.marketData?.priceHistory?.[ctx.network] || [];
      const ma20 = this.calculateSMA(prices, 20);
      const ma50 = this.calculateSMA(prices, 50);

      if (!ma20 || !ma50) return 'sideways';

      const diff = ((ma20 - ma50) / ma50) * 100;

      if (diff > 2) return 'uptrend';
      if (diff < -2) return 'downtrend';
      return 'sideways';
    }, {
      type: 'string',
      description: 'Trend direction (uptrend, downtrend, sideways)',
      category: 'technical'
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

export default TechnicalIndicators;
