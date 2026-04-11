/**
 * Position Indicators
 *
 * Portfolio and position-related indicators for rule-based strategies.
 */

export class PositionIndicators {
  constructor() {
    this.indicators = new Map();
    this.metadataMap = new Map();
    this.registerIndicators();
  }

  registerIndicators() {
    // In position (not in stablecoin)
    this.register('in_position', async (ctx) => {
      if (!ctx.strategy) return false;
      const position = ctx.strategy.getPosition(ctx.network);
      return !position.inStablecoin;
    }, {
      type: 'boolean',
      description: 'True if holding native asset (not in stablecoin)',
      category: 'position'
    });

    // In stablecoin
    this.register('in_stablecoin', async (ctx) => {
      if (!ctx.strategy) return true;
      const position = ctx.strategy.getPosition(ctx.network);
      return position.inStablecoin === true;
    }, {
      type: 'boolean',
      description: 'True if holding stablecoin',
      category: 'position'
    });

    // Position size in native units
    this.register('position_size', async (ctx) => {
      if (!ctx.strategy) return 0;
      const position = ctx.strategy.getPosition(ctx.network);
      return position.nativeAmount || 0;
    }, {
      type: 'number',
      description: 'Position size in native asset units',
      category: 'position'
    });

    // Stablecoin balance
    this.register('stablecoin_balance', async (ctx) => {
      if (!ctx.strategy) return 0;
      const position = ctx.strategy.getPosition(ctx.network);
      return position.stablecoinAmount || 0;
    }, {
      type: 'number',
      description: 'Stablecoin balance (USD)',
      category: 'position'
    });

    // Entry price
    this.register('entry_price', async (ctx) => {
      if (!ctx.strategy) return 0;
      const position = ctx.strategy.getPosition(ctx.network);
      return position.entryPrice || 0;
    }, {
      type: 'number',
      description: 'Entry price for current position',
      category: 'position'
    });

    // Unrealized P&L (USD)
    this.register('unrealized_pnl', async (ctx) => {
      if (!ctx.strategy) return 0;
      const position = ctx.strategy.getPosition(ctx.network);
      if (!position.entryPrice || position.inStablecoin) return 0;

      const currentPrice = ctx.marketData?.prices?.[ctx.network]?.price || 0;
      const positionValue = (position.nativeAmount || 0) * currentPrice;
      const costBasis = (position.nativeAmount || 0) * position.entryPrice;

      return positionValue - costBasis;
    }, {
      type: 'number',
      description: 'Unrealized profit/loss in USD',
      category: 'position'
    });

    // Unrealized P&L (%)
    this.register('unrealized_pnl_percent', async (ctx) => {
      if (!ctx.strategy) return 0;
      const position = ctx.strategy.getPosition(ctx.network);
      if (!position.entryPrice || position.inStablecoin || position.entryPrice === 0) return 0;

      const currentPrice = ctx.marketData?.prices?.[ctx.network]?.price || 0;
      return ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    }, {
      type: 'number',
      description: 'Unrealized profit/loss as percentage',
      category: 'position'
    });

    // Time in position (hours)
    this.register('time_in_position_hours', async (ctx) => {
      if (!ctx.strategy) return 0;
      const position = ctx.strategy.getPosition(ctx.network);
      if (!position.timestamp) return 0;

      const entryTime = new Date(position.timestamp);
      return (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);
    }, {
      type: 'number',
      description: 'Hours since position entry',
      category: 'position'
    });

    // Minutes since last trade
    this.register('minutes_since_last_trade', async (ctx) => {
      if (!ctx.strategy?.state?.lastExecution?.timestamp) return Infinity;
      const lastTrade = new Date(ctx.strategy.state.lastExecution.timestamp);
      return (Date.now() - lastTrade.getTime()) / (1000 * 60);
    }, {
      type: 'number',
      description: 'Minutes since last trade execution',
      category: 'position'
    });

    // Total PnL
    this.register('total_pnl', async (ctx) => {
      if (!ctx.strategy) return 0;
      return ctx.strategy.state?.totalPnL || 0;
    }, {
      type: 'number',
      description: 'Total realized profit/loss',
      category: 'position'
    });

    // Daily PnL
    this.register('daily_pnl', async (ctx) => {
      if (!ctx.strategy) return 0;
      return ctx.strategy.state?.dailyPnL || 0;
    }, {
      type: 'number',
      description: 'Today\'s realized profit/loss',
      category: 'position'
    });

    // Trades executed count
    this.register('trades_executed', async (ctx) => {
      if (!ctx.strategy) return 0;
      return ctx.strategy.state?.tradesExecuted || 0;
    }, {
      type: 'number',
      description: 'Total number of trades executed',
      category: 'position'
    });

    // Position value (USD)
    this.register('position_value', async (ctx) => {
      if (!ctx.strategy) return 0;
      const position = ctx.strategy.getPosition(ctx.network);

      if (position.inStablecoin) {
        return position.stablecoinAmount || 0;
      }

      const currentPrice = ctx.marketData?.prices?.[ctx.network]?.price || 0;
      return (position.nativeAmount || 0) * currentPrice;
    }, {
      type: 'number',
      description: 'Current position value in USD',
      category: 'position'
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

export default PositionIndicators;
