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

    // Composite risk score for the open position
    this.register('position_risk_score', (ctx) => this.calculatePositionRiskScore(ctx), {
      type: 'number',
      description: 'Composite position risk score based on volatility, time, and unrealized losses',
      category: 'risk'
    });

    // Stop-loss proximity level
    this.register('stop_loss_risk_level', (ctx) => this.calculateStopLossRiskLevel(ctx), {
      type: 'string',
      description: 'Stop-loss proximity level (low, medium, high)',
      category: 'risk'
    });

    // Concentration risk
    this.register('concentration_risk', (ctx) => this.calculateConcentrationRisk(ctx), {
      type: 'number',
      description: 'Position concentration as percentage of network portfolio value (position + stablecoin)',
      category: 'risk'
    });
  }

  /**
   * Calculate position risk score based on volatility, time in position, and unrealized losses
   * @param {Object} ctx - Context object containing strategy, network, and market data
   * @returns {Number} Risk score (0+, higher = riskier)
   */
  async calculatePositionRiskScore(ctx) {
    if (!ctx.strategy) return 0;

    const position = ctx.strategy.getPosition(ctx.network);
    const marketData = ctx.marketData?.prices?.[ctx.network];

    if (!marketData || !position.entryPrice || position.inStablecoin) return 0;

    const currentPrice = marketData.price;
    const volatility = marketData.volatility || 0;
    // Position age from updatedAt (set by setPosition); absent = 0 time risk
    const enteredAt = position.updatedAt ? new Date(position.updatedAt).getTime() : NaN;
    const timeInPosition = Number.isFinite(enteredAt) ? (Date.now() - enteredAt) / (1000 * 60 * 60) : 0;

    // Calculate unrealized P&L percentage
    const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

    // Risk factors:
    // 1. Volatility component (higher volatility = higher risk)
    // 2. Time in position (longer = higher risk)
    // 3. Unrealized loss (larger losses = higher risk)
    const volatilityRisk = volatility * 10;
    const timeRisk = Math.min(timeInPosition / 24, 10); // Cap at 10 for 24+ hours
    const lossRisk = pnlPercent < 0 ? Math.abs(pnlPercent) : 0;

    // Weighted combination
    return (volatilityRisk * 0.4) + (timeRisk * 0.3) + (lossRisk * 0.3);
  }

  /**
   * Determine risk level based on proximity to the strategy's stop-loss
   * @param {Object} ctx - Context object containing strategy, network, and market data
   * @returns {String} Risk level: 'low', 'medium', or 'high'
   */
  async calculateStopLossRiskLevel(ctx) {
    if (!ctx.strategy) return 'low';

    const position = ctx.strategy.getPosition(ctx.network);
    const marketData = ctx.marketData?.prices?.[ctx.network];

    if (!marketData || !position.entryPrice || position.inStablecoin) return 'low';

    const currentPrice = marketData.price;
    // Strategies store stop-loss as a negative percent (stopLossThreshold: -3)
    const config = ctx.strategy.config || {};
    const stopLossLevel = Math.abs(config.stopLossPercentage ?? config.stopLossThreshold ?? 10);

    // Distance already lost toward the stop (positive = underwater)
    const distanceToStopLoss = (position.entryPrice - currentPrice) / position.entryPrice * 100;

    if (distanceToStopLoss >= stopLossLevel * 0.8) return 'high';
    if (distanceToStopLoss >= stopLossLevel * 0.5) return 'medium';
    return 'low';
  }

  /**
   * Calculate position concentration as a percentage of the network's portfolio
   * (position value + stablecoin reserve), or state.portfolioValue if a strategy tracks it
   * @param {Object} ctx - Context object containing strategy, network, and market data
   * @returns {Number} Concentration percentage (0-100)
   */
  async calculateConcentrationRisk(ctx) {
    if (!ctx.strategy) return 0;

    const position = ctx.strategy.getPosition(ctx.network);
    const marketData = ctx.marketData?.prices?.[ctx.network];

    if (!marketData || position.inStablecoin) return 0;

    const positionValue = (position.nativeAmount || 0) * marketData.price;
    const totalPortfolioValue = ctx.strategy.state?.portfolioValue
      || (positionValue + (position.stablecoinAmount || 0));
    if (totalPortfolioValue <= 0) return 0;

    const concentration = (positionValue / totalPortfolioValue) * 100;
    return Math.min(concentration, 100);
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
