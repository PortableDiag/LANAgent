import { BaseStrategy } from './BaseStrategy.js';
import { logger } from '../../../utils/logger.js';

/**
 * Grid Trading Strategy
 * Goal: Profit from sideways/choppy markets by placing orders at price intervals
 *
 * Logic:
 * - Define a price grid with buy levels below current price and sell levels above
 * - Buy when price drops to a grid level, sell when it rises to a grid level
 * - Works best in ranging/sideways markets
 * - Each grid level acts as both entry and exit depending on direction
 */
export class GridTradingStrategy extends BaseStrategy {
    constructor() {
        super(
            'grid_trading',
            'Grid Trading - Profit from price oscillations by trading at fixed intervals'
        );

        // Strategy-specific config
        this.config = {
            ...this.config,
            // Grid settings
            gridLevels: 5,              // Number of grid levels above and below
            gridSpacing: 2,             // Percentage between grid levels
            tradePerLevel: 10,          // Percentage of portfolio per grid level
            // Per-asset grid settings
            assetSettings: {
                'BNB': { gridLevels: 5, gridSpacing: 2 },
                'ETH': { gridLevels: 5, gridSpacing: 1.5 },  // ETH less volatile, tighter grid
                'MATIC': { gridLevels: 6, gridSpacing: 2.5 } // MATIC more volatile, wider grid
            }
        };

        // Grid-specific state
        this.state = {
            ...this.state,
            grids: {},           // Per-network grid configurations
            filledLevels: {},    // Track which levels have been filled
            gridPnL: {},         // Track PnL per grid
            priceHistory: {}     // Track price history for volatility calculation
        };
    }

    /**
     * Get grid settings for a specific asset
     */
    getAssetSettings(symbol) {
        const custom = this.config.assetSettings[symbol];
        if (custom) {
            return {
                gridLevels: custom.gridLevels,
                gridSpacing: custom.gridSpacing
            };
        }
        return {
            gridLevels: this.config.gridLevels,
            gridSpacing: this.config.gridSpacing
        };
    }

    /**
     * Record a price observation and maintain rolling history
     */
    recordPrice(symbol, price) {
        if (!this.state.priceHistory[symbol]) {
            this.state.priceHistory[symbol] = [];
        }
        this.state.priceHistory[symbol].push({ price, timestamp: Date.now() });
        // Keep last 100 observations (roughly ~8 hours at 5-min intervals)
        if (this.state.priceHistory[symbol].length > 100) {
            this.state.priceHistory[symbol] = this.state.priceHistory[symbol].slice(-100);
        }
    }

    /**
     * Calculate recent price volatility as standard deviation of returns
     * Returns a multiplier: 1.0 = normal, >1 = high volatility, <1 = low volatility
     */
    calculateVolatilityMultiplier(symbol) {
        const history = this.state.priceHistory[symbol];
        if (!history || history.length < 5) {
            return 1.0; // Not enough data, use default spacing
        }

        // Calculate percentage returns
        const returns = [];
        for (let i = 1; i < history.length; i++) {
            const ret = (history[i].price - history[i - 1].price) / history[i - 1].price;
            returns.push(ret);
        }

        // Standard deviation of returns
        const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);

        // Normalize: 0.5% stddev is "normal" for crypto, scale around that
        const normalStdDev = 0.005;
        const multiplier = Math.max(0.5, Math.min(2.5, stdDev / normalStdDev));

        return multiplier;
    }

    /**
     * Get adaptive grid settings based on current volatility
     * Adjusts both grid spacing and grid levels dynamically
     */
    getAdaptiveSettings(symbol, marketData) {
        const baseSettings = this.getAssetSettings(symbol);

        // Also use marketData.priceHistory if available (from the market data service)
        if (marketData?.priceHistory?.[symbol]) {
            const externalHistory = marketData.priceHistory[symbol];
            if (Array.isArray(externalHistory)) {
                for (const price of externalHistory.slice(-20)) {
                    if (typeof price === 'number') {
                        this.recordPrice(symbol, price);
                    }
                }
            }
        }

        const volMultiplier = this.calculateVolatilityMultiplier(symbol);

        // Adjust spacing: wider in volatile markets, tighter in calm markets
        const adaptiveSpacing = parseFloat((baseSettings.gridSpacing * volMultiplier).toFixed(2));
        // Clamp spacing between 0.5% and 8%
        const clampedSpacing = Math.max(0.5, Math.min(8, adaptiveSpacing));

        // Adjust grid levels: more levels in volatile markets, fewer in calm markets
        const adaptiveLevels = Math.round(baseSettings.gridLevels * volMultiplier);
        // Clamp levels between 3 and 10
        const clampedLevels = Math.max(3, Math.min(10, adaptiveLevels));

        if (Math.abs(volMultiplier - 1.0) > 0.15) {
            logger.info(`[GridTrading] Adaptive settings for ${symbol}: base levels=${baseSettings.gridLevels}, base spacing=${baseSettings.gridSpacing}%, volatility=${volMultiplier.toFixed(2)}x, adjusted levels=${clampedLevels}, adjusted spacing=${clampedSpacing}%`);
        }

        return {
            gridLevels: clampedLevels,
            gridSpacing: clampedSpacing
        };
    }

    /**
     * Initialize or update grid for a network
     */
    initializeGrid(network, pair, networkMode, currentPrice, symbol, marketData) {
        const key = this.getBaselineKey(network, pair, networkMode);
        const settings = marketData ? this.getAdaptiveSettings(symbol, marketData) : this.getAssetSettings(symbol);

        // Create grid levels
        const levels = [];
        const spacing = settings.gridSpacing / 100;

        // Buy levels (below current price)
        for (let i = 1; i <= settings.gridLevels; i++) {
            levels.push({
                type: 'buy',
                level: i,
                price: currentPrice * (1 - spacing * i),
                filled: false,
                fillPrice: null,
                fillTime: null
            });
        }

        // Sell levels (above current price)
        for (let i = 1; i <= settings.gridLevels; i++) {
            levels.push({
                type: 'sell',
                level: i,
                price: currentPrice * (1 + spacing * i),
                filled: false,
                fillPrice: null,
                fillTime: null
            });
        }

        this.state.grids[key] = {
            centerPrice: currentPrice,
            levels,
            createdAt: new Date(),
            settings
        };

        logger.info(`[GridTrading] Initialized grid for ${pair} at center $${currentPrice.toFixed(2)} with ${settings.gridLevels} levels, ${settings.gridSpacing}% spacing`);

        return this.state.grids[key];
    }

    /**
     * Check if grid needs recentering (price moved too far from center)
     */
    needsRecentering(grid, currentPrice) {
        const deviation = Math.abs((currentPrice - grid.centerPrice) / grid.centerPrice) * 100;
        // Recenter if price moved more than 2x the total grid range
        const totalRange = grid.settings.gridSpacing * grid.settings.gridLevels;
        return deviation > totalRange * 2;
    }

    /**
     * Analyze market for grid trading opportunities
     */
    async analyze(marketData, portfolio, network, networkMode, tokenConfig) {
        const analysis = {
            network,
            networkMode,
            opportunity: null,
            currentPrice: 0,
            gridStatus: null,
            reason: null
        };

        const symbol = tokenConfig.symbol.replace('t', '');
        const pricePair = `${symbol}/USD`;
        const currentPrice = marketData.prices[pricePair]?.price;

        if (!currentPrice) {
            analysis.reason = `No price data for ${pricePair}`;
            return analysis;
        }

        analysis.currentPrice = currentPrice;
        const key = this.getBaselineKey(network, pricePair, networkMode);

        // Record price for volatility tracking
        this.recordPrice(symbol, currentPrice);

        // Get or initialize grid
        let grid = this.state.grids[key];
        if (!grid || this.needsRecentering(grid, currentPrice)) {
            grid = this.initializeGrid(network, pricePair, networkMode, currentPrice, symbol, marketData);
            if (this.needsRecentering(grid, currentPrice)) {
                analysis.reason = `Grid recentered at $${currentPrice.toFixed(2)}`;
            }
        }

        analysis.gridStatus = {
            centerPrice: grid.centerPrice,
            levels: grid.levels.length,
            filledBuys: grid.levels.filter(l => l.type === 'buy' && l.filled).length,
            filledSells: grid.levels.filter(l => l.type === 'sell' && l.filled).length
        };

        // Find triggered levels
        for (const level of grid.levels) {
            if (level.filled) continue;

            if (level.type === 'buy' && currentPrice <= level.price) {
                // Price dropped to buy level
                analysis.opportunity = {
                    action: 'grid_buy',
                    level: level.level,
                    targetPrice: level.price,
                    currentPrice,
                    reason: `Grid buy triggered at level ${level.level} ($${level.price.toFixed(2)}). Price: $${currentPrice.toFixed(2)}`,
                    confidence: 80
                };
                break;
            } else if (level.type === 'sell' && currentPrice >= level.price) {
                // Price rose to sell level
                analysis.opportunity = {
                    action: 'grid_sell',
                    level: level.level,
                    targetPrice: level.price,
                    currentPrice,
                    reason: `Grid sell triggered at level ${level.level} ($${level.price.toFixed(2)}). Price: $${currentPrice.toFixed(2)}`,
                    confidence: 80
                };
                break;
            }
        }

        if (!analysis.opportunity) {
            // Find nearest levels
            const nearestBuy = grid.levels
                .filter(l => l.type === 'buy' && !l.filled)
                .sort((a, b) => b.price - a.price)[0];
            const nearestSell = grid.levels
                .filter(l => l.type === 'sell' && !l.filled)
                .sort((a, b) => a.price - b.price)[0];

            analysis.reason = `Waiting. Next buy at $${nearestBuy?.price?.toFixed(2) || 'N/A'}, next sell at $${nearestSell?.price?.toFixed(2) || 'N/A'}`;
        }

        return analysis;
    }

    /**
     * Make trading decisions
     */
    async decide(analyses, portfolio, config) {
        const decisions = [];

        for (const analysis of analyses) {
            if (!analysis.opportunity) continue;

            const { opportunity, network, currentPrice, networkMode } = analysis;
            const balance = portfolio.balances[network];

            if (!balance) continue;

            const nativeBalance = parseFloat(balance.native) || 0;
            const tradeAmount = nativeBalance * (this.config.tradePerLevel / 100);

            if (opportunity.action === 'grid_buy' && tradeAmount >= config.minTradeValueNative) {
                decisions.push({
                    strategy: this.name,
                    network,
                    action: 'grid_buy',
                    amount: tradeAmount.toString(),
                    symbol: balance.symbol,
                    reason: opportunity.reason,
                    confidence: opportunity.confidence,
                    priceAtDecision: currentPrice,
                    gridLevel: opportunity.level,
                    expectedSlippage: config.slippageTolerance
                });
                this.state.tradesProposed++;
            } else if (opportunity.action === 'grid_sell' && nativeBalance > config.minTradeValueNative) {
                const sellAmount = Math.min(tradeAmount, nativeBalance * 0.9);
                decisions.push({
                    strategy: this.name,
                    network,
                    action: 'grid_sell',
                    amount: sellAmount.toString(),
                    symbol: balance.symbol,
                    reason: opportunity.reason,
                    confidence: opportunity.confidence,
                    priceAtDecision: currentPrice,
                    gridLevel: opportunity.level,
                    expectedSlippage: config.slippageTolerance
                });
                this.state.tradesProposed++;
            }
        }

        if (decisions.length > 0) {
            this.state.lastDecision = {
                timestamp: new Date(),
                decisions
            };
        }

        return decisions;
    }

    /**
     * Mark a grid level as filled
     */
    markLevelFilled(network, pair, networkMode, levelType, levelNum, fillPrice) {
        const key = this.getBaselineKey(network, pair, networkMode);
        const grid = this.state.grids[key];

        if (!grid) return;

        const level = grid.levels.find(l => l.type === levelType && l.level === levelNum);
        if (level) {
            level.filled = true;
            level.fillPrice = fillPrice;
            level.fillTime = new Date();
            logger.info(`[GridTrading] Marked ${levelType} level ${levelNum} as filled at $${fillPrice.toFixed(2)}`);
        }
    }

    /**
     * Get grid statistics
     */
    getGridStats() {
        const stats = {};
        for (const [key, grid] of Object.entries(this.state.grids)) {
            const buysFilled = grid.levels.filter(l => l.type === 'buy' && l.filled).length;
            const sellsFilled = grid.levels.filter(l => l.type === 'sell' && l.filled).length;
            stats[key] = {
                centerPrice: grid.centerPrice,
                totalLevels: grid.levels.length,
                buysFilled,
                sellsFilled,
                spacing: grid.settings.gridSpacing,
                createdAt: grid.createdAt
            };
        }

        // Add volatility info per symbol
        const volatility = {};
        for (const [symbol, history] of Object.entries(this.state.priceHistory)) {
            volatility[symbol] = {
                dataPoints: history.length,
                multiplier: this.calculateVolatilityMultiplier(symbol)
            };
        }
        if (Object.keys(volatility).length > 0) {
            stats._volatility = volatility;
        }

        return stats;
    }
}

export default GridTradingStrategy;
