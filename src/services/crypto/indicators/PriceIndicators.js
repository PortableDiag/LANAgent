/**
 * Price Indicators
 *
 * Price-related indicators for rule-based strategies.
 */

export class PriceIndicators {
  constructor() {
    this.indicators = new Map();
    this.metadataMap = new Map();
    this.registerIndicators();
  }

  registerIndicators() {
    // Current price
    this.register('price', async (ctx) => {
      return ctx.marketData?.prices?.[ctx.network]?.price || 0;
    }, {
      type: 'number',
      description: 'Current asset price in USD',
      category: 'price'
    });

    // Price change 1h
    this.register('price_change_1h', async (ctx) => {
      return ctx.marketData?.prices?.[ctx.network]?.change1h || 0;
    }, {
      type: 'number',
      description: 'Price change in last hour (%)',
      category: 'price'
    });

    // Price change 24h
    this.register('price_change_24h', async (ctx) => {
      return ctx.marketData?.prices?.[ctx.network]?.change24h || 0;
    }, {
      type: 'number',
      description: 'Price change in last 24 hours (%)',
      category: 'price'
    });

    // Price change 7d
    this.register('price_change_7d', async (ctx) => {
      return ctx.marketData?.prices?.[ctx.network]?.change7d || 0;
    }, {
      type: 'number',
      description: 'Price change in last 7 days (%)',
      category: 'price'
    });

    // Price change 30d
    this.register('price_change_30d', async (ctx) => {
      return ctx.marketData?.prices?.[ctx.network]?.change30d || 0;
    }, {
      type: 'number',
      description: 'Price change in last 30 days (%)',
      category: 'price'
    });

    // Price change 90d
    this.register('price_change_90d', async (ctx) => {
      return ctx.marketData?.prices?.[ctx.network]?.change90d || 0;
    }, {
      type: 'number',
      description: 'Price change in last 90 days (%)',
      category: 'price'
    });

    // Price vs baseline
    this.register('price_vs_baseline', async (ctx) => {
      if (!ctx.strategy) return 0;
      const baseline = ctx.strategy.getBaseline(ctx.network, ctx.asset, ctx.networkMode);
      if (!baseline?.price) return 0;
      const currentPrice = ctx.marketData?.prices?.[ctx.network]?.price || 0;
      if (baseline.price === 0) return 0;
      return ((currentPrice - baseline.price) / baseline.price) * 100;
    }, {
      type: 'number',
      description: 'Price change from strategy baseline (%)',
      category: 'price'
    });

    // High 24h
    this.register('high_24h', async (ctx) => {
      return ctx.marketData?.prices?.[ctx.network]?.high24h || 0;
    }, {
      type: 'number',
      description: '24-hour high price',
      category: 'price'
    });

    // Low 24h
    this.register('low_24h', async (ctx) => {
      return ctx.marketData?.prices?.[ctx.network]?.low24h || 0;
    }, {
      type: 'number',
      description: '24-hour low price',
      category: 'price'
    });

    // Price vs 24h high
    this.register('price_vs_high_24h', async (ctx) => {
      const price = ctx.marketData?.prices?.[ctx.network]?.price || 0;
      const high = ctx.marketData?.prices?.[ctx.network]?.high24h || price;
      if (high === 0) return 0;
      return ((price - high) / high) * 100;
    }, {
      type: 'number',
      description: 'Current price vs 24h high (%)',
      category: 'price'
    });

    // Price vs 24h low
    this.register('price_vs_low_24h', async (ctx) => {
      const price = ctx.marketData?.prices?.[ctx.network]?.price || 0;
      const low = ctx.marketData?.prices?.[ctx.network]?.low24h || price;
      if (low === 0) return 0;
      return ((price - low) / low) * 100;
    }, {
      type: 'number',
      description: 'Current price vs 24h low (%)',
      category: 'price'
    });

    // Weighted price trend score from available change percentages
    this.register('price_trend', async (ctx) => {
      const data = ctx.marketData?.prices?.[ctx.network];
      if (!data?.price) return 0;
      const change7d = data.change7d || 0;
      const change24h = data.change24h || 0;
      const change1h = data.change1h || 0;
      return (change7d * 0.5) + (change24h * 0.35) + (change1h * 0.15);
    }, {
      type: 'number',
      description: 'Weighted price trend score (positive = uptrend, negative = downtrend)',
      category: 'price'
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

export default PriceIndicators;
