/**
 * Momentum/Trend Following Strategy
 * Goal: Trade in the direction of the prevailing trend
 *
 * Logic:
 * - Use moving average crossovers to identify trend direction
 * - Only buy in confirmed uptrends, sell/stay out in downtrends
 * - Avoids "catching falling knives" by waiting for trend confirmation
 * - Uses fast and slow MAs to detect trend changes
 */
import { BaseStrategy } from './BaseStrategy.js';
import { logger } from '../../../utils/logger.js';

export class MomentumStrategy extends BaseStrategy {
    constructor() {
        super(
            'momentum',
            'Momentum/Trend Following - Trade with the trend, not against it'
        );

        // Strategy-specific config
        this.config = {
            ...this.config,
            // Moving average settings
            fastMAPeriodHours: 6,        // Fast MA period (hours)
            slowMAPeriodHours: 24,       // Slow MA period (hours)
            minDataPoints: 24,           // Minimum data points before trading

            // Trend confirmation
            trendStrengthThreshold: 1,   // Minimum % difference between MAs for trend confirmation
            momentumThreshold: 2,        // Minimum % price momentum for entry

            // Position management
            trailingStopPercent: 5,      // Trailing stop in uptrend
            trendReverseExit: true,      // Exit on trend reversal

            // Per-asset settings
            assetSettings: {
                'BNB': { fastMA: 6, slowMA: 24, trendStrength: 1 },
                'ETH': { fastMA: 8, slowMA: 24, trendStrength: 0.8 },
                'MATIC': { fastMA: 4, slowMA: 24, trendStrength: 1.5 }
            }
        };

        // Momentum-specific state
        this.state = {
            ...this.state,
            priceHistory: {},      // Historical prices
            fastMA: {},            // Fast moving averages
            slowMA: {},            // Slow moving averages
            trend: {},             // Current trend direction
            trendStrength: {},     // Trend strength
            entryPrice: {},        // Entry price for trailing stop
            highSinceEntry: {}     // High since entry for trailing stop
        };
    }

    /**
     * Get settings for a specific asset
     */
    getAssetSettings(symbol) {
        const custom = this.config.assetSettings[symbol];
        if (custom) {
            return {
                fastMA: custom.fastMA,
                slowMA: custom.slowMA,
                trendStrength: custom.trendStrength
            };
        }
        return {
            fastMA: this.config.fastMAPeriodHours,
            slowMA: this.config.slowMAPeriodHours,
            trendStrength: this.config.trendStrengthThreshold
        };
    }

    /**
     * Add price to history
     */
    addPriceToHistory(network, pair, networkMode, price) {
        const key = this.getBaselineKey(network, pair, networkMode);

        if (!this.state.priceHistory[key]) {
            this.state.priceHistory[key] = [];
        }

        this.state.priceHistory[key].push({
            price,
            timestamp: Date.now()
        });

        // Keep prices for slow MA period + buffer
        const cutoffTime = Date.now() - (this.config.slowMAPeriodHours * 2 * 60 * 60 * 1000);
        this.state.priceHistory[key] = this.state.priceHistory[key].filter(
            p => p.timestamp > cutoffTime
        );
    }

    /**
     * Calculate moving average for a given period
     */
    calculateMA(prices, periodHours) {
        const cutoffTime = Date.now() - (periodHours * 60 * 60 * 1000);
        const relevantPrices = prices.filter(p => p.timestamp > cutoffTime);

        if (relevantPrices.length < 3) return null;

        const sum = relevantPrices.reduce((acc, p) => acc + p.price, 0);
        return sum / relevantPrices.length;
    }

    /**
     * Calculate market volatility as average absolute price change percentage
     */
    calculateVolatility(prices, periodHours) {
        const cutoffTime = Date.now() - (periodHours * 60 * 60 * 1000);
        const relevantPrices = prices.filter(p => p.timestamp > cutoffTime);

        if (relevantPrices.length < 2) return 0;

        const priceChanges = relevantPrices.slice(1).map((p, i) => {
            return Math.abs((p.price - relevantPrices[i].price) / relevantPrices[i].price);
        });

        const averageChange = priceChanges.reduce((acc, change) => acc + change, 0) / priceChanges.length;
        return averageChange * 100;
    }

    /**
     * Adjust moving average periods based on volatility
     * Higher volatility = longer periods (smoother), lower volatility = shorter periods (more responsive)
     */
    adjustMAPeriods(symbol, volatility) {
        const settings = this.getAssetSettings(symbol);
        const volatilityFactor = Math.min(Math.max(volatility / 2, 0.5), 2);

        return {
            fastMA: Math.round(settings.fastMA * volatilityFactor),
            slowMA: Math.round(settings.slowMA * volatilityFactor)
        };
    }

    /**
     * Determine trend direction and strength
     */
    analyzeTrend(network, pair, networkMode, symbol) {
        const key = this.getBaselineKey(network, pair, networkMode);
        const history = this.state.priceHistory[key];

        if (!history || history.length < this.config.minDataPoints) {
            return { trend: 'unknown', strength: 0, fastMA: null, slowMA: null };
        }

        const settings = this.getAssetSettings(symbol);

        // Calculate volatility-adjusted MA periods
        const volatility = this.calculateVolatility(history, settings.slowMA);
        const adjustedPeriods = this.adjustMAPeriods(symbol, volatility);

        // Calculate MAs using volatility-adjusted periods
        const fastMA = this.calculateMA(history, adjustedPeriods.fastMA);
        const slowMA = this.calculateMA(history, adjustedPeriods.slowMA);

        if (!fastMA || !slowMA) {
            return { trend: 'unknown', strength: 0, fastMA: null, slowMA: null };
        }

        // Store MAs
        this.state.fastMA[key] = fastMA;
        this.state.slowMA[key] = slowMA;

        // Calculate trend strength as % difference between MAs
        const strength = ((fastMA - slowMA) / slowMA) * 100;
        this.state.trendStrength[key] = strength;

        // Determine trend
        let trend = 'sideways';
        if (strength > settings.trendStrength) {
            trend = 'uptrend';
        } else if (strength < -settings.trendStrength) {
            trend = 'downtrend';
        }

        this.state.trend[key] = trend;

        return { trend, strength, fastMA, slowMA };
    }

    /**
     * Calculate price momentum (rate of change)
     */
    calculateMomentum(prices, periodHours) {
        const cutoffTime = Date.now() - (periodHours * 60 * 60 * 1000);
        const oldPrice = prices.find(p => p.timestamp <= cutoffTime);
        const currentPrice = prices[prices.length - 1];

        if (!oldPrice || !currentPrice) return 0;

        return ((currentPrice.price - oldPrice.price) / oldPrice.price) * 100;
    }

    /**
     * Analyze market for momentum/trend opportunities
     */
    async analyze(marketData, portfolio, network, networkMode, tokenConfig) {
        const analysis = {
            network,
            networkMode,
            opportunity: null,
            currentPrice: 0,
            trend: null,
            trendStrength: null,
            fastMA: null,
            slowMA: null,
            momentum: null,
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

        // Add price to history
        this.addPriceToHistory(network, pricePair, networkMode, currentPrice);

        // Analyze trend
        const trendAnalysis = this.analyzeTrend(network, pricePair, networkMode, symbol);
        analysis.trend = trendAnalysis.trend;
        analysis.trendStrength = trendAnalysis.strength;
        analysis.fastMA = trendAnalysis.fastMA;
        analysis.slowMA = trendAnalysis.slowMA;

        if (trendAnalysis.trend === 'unknown') {
            const dataPoints = this.state.priceHistory[key]?.length || 0;
            analysis.reason = `Collecting trend data: ${dataPoints}/${this.config.minDataPoints} points needed`;
            return analysis;
        }

        // Calculate momentum
        const history = this.state.priceHistory[key];
        analysis.momentum = this.calculateMomentum(history, 6); // 6-hour momentum

        // Get position
        const position = this.getPosition(network);

        // Track high since entry for trailing stop
        if (!position.inStablecoin) {
            if (!this.state.highSinceEntry[key] || currentPrice > this.state.highSinceEntry[key]) {
                this.state.highSinceEntry[key] = currentPrice;
            }
        }

        // Decision logic based on trend
        const settings = this.getAssetSettings(symbol);

        if (trendAnalysis.trend === 'uptrend') {
            if (position.inStablecoin) {
                // In uptrend and holding stablecoin - look to buy
                if (analysis.momentum >= this.config.momentumThreshold) {
                    analysis.opportunity = {
                        action: 'buy_native',
                        reason: `📈 UPTREND confirmed for ${symbol}. Fast MA ($${trendAnalysis.fastMA.toFixed(2)}) > Slow MA ($${trendAnalysis.slowMA.toFixed(2)}). Momentum: +${analysis.momentum.toFixed(2)}%`,
                        confidence: Math.min(90, 70 + trendAnalysis.strength * 2),
                        trend: 'uptrend',
                        trendStrength: trendAnalysis.strength
                    };
                } else {
                    analysis.reason = `Uptrend confirmed but waiting for stronger momentum (currently ${analysis.momentum.toFixed(2)}%, need ${this.config.momentumThreshold}%)`;
                }
            } else {
                // In uptrend and holding native - check trailing stop
                const entryHigh = this.state.highSinceEntry[key] || currentPrice;
                const dropFromHigh = ((currentPrice - entryHigh) / entryHigh) * 100;

                if (dropFromHigh <= -this.config.trailingStopPercent) {
                    analysis.opportunity = {
                        action: 'trailing_stop_sell',
                        reason: `⚠️ Trailing stop triggered. ${symbol} dropped ${Math.abs(dropFromHigh).toFixed(2)}% from high of $${entryHigh.toFixed(2)}`,
                        confidence: 85,
                        trend: 'uptrend',
                        isTrailingStop: true
                    };
                } else {
                    analysis.reason = `🟢 HOLDING in uptrend. ${symbol} is ${dropFromHigh.toFixed(2)}% from high. Trailing stop at -${this.config.trailingStopPercent}%`;
                }
            }
        } else if (trendAnalysis.trend === 'downtrend') {
            if (!position.inStablecoin && this.config.trendReverseExit) {
                // In downtrend and holding native - exit
                analysis.opportunity = {
                    action: 'trend_exit_sell',
                    reason: `📉 DOWNTREND detected for ${symbol}. Fast MA ($${trendAnalysis.fastMA.toFixed(2)}) < Slow MA ($${trendAnalysis.slowMA.toFixed(2)}). Exiting to preserve capital.`,
                    confidence: Math.min(90, 70 + Math.abs(trendAnalysis.strength) * 2),
                    trend: 'downtrend',
                    trendStrength: trendAnalysis.strength
                };
            } else {
                analysis.reason = `🔴 DOWNTREND - staying out. Waiting for trend reversal. Strength: ${trendAnalysis.strength.toFixed(2)}%`;
            }
        } else {
            // Sideways
            analysis.reason = `↔️ SIDEWAYS market. MAs converging (diff: ${trendAnalysis.strength.toFixed(2)}%). Waiting for trend confirmation.`;
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

            const { opportunity, network, currentPrice } = analysis;
            const balance = portfolio.balances[network];

            if (!balance) continue;

            const nativeBalance = parseFloat(balance.native) || 0;
            const position = this.getPosition(network);
            const key = this.getBaselineKey(network, `${balance.symbol}/USD`, analysis.networkMode);

            if (opportunity.action === 'buy_native' && position.inStablecoin && position.stablecoinAmount > 0) {
                // Record entry for trailing stop
                this.state.entryPrice[key] = currentPrice;
                this.state.highSinceEntry[key] = currentPrice;

                decisions.push({
                    strategy: this.name,
                    network,
                    action: 'buy_native',
                    amount: position.stablecoinAmount.toString(),
                    symbol: balance.symbol,
                    reason: opportunity.reason,
                    confidence: opportunity.confidence,
                    priceAtDecision: currentPrice,
                    trend: opportunity.trend,
                    expectedSlippage: config.slippageTolerance
                });
                this.state.tradesProposed++;
            } else if ((opportunity.action === 'trailing_stop_sell' || opportunity.action === 'trend_exit_sell') && nativeBalance > config.minTradeValueNative) {
                // Sell on stop or trend reversal
                const tradeAmount = Math.min(
                    nativeBalance * 0.9,
                    nativeBalance * (config.maxTradePercentage / 100) * 2 // Larger exit on trend reversal
                );

                if (tradeAmount >= config.minTradeValueNative) {
                    // Clear entry tracking
                    delete this.state.entryPrice[key];
                    delete this.state.highSinceEntry[key];

                    decisions.push({
                        strategy: this.name,
                        network,
                        action: opportunity.action,
                        amount: tradeAmount.toString(),
                        symbol: balance.symbol,
                        reason: opportunity.reason,
                        confidence: opportunity.confidence,
                        priceAtDecision: currentPrice,
                        trend: opportunity.trend,
                        isTrailingStop: opportunity.isTrailingStop || false,
                        expectedSlippage: config.slippageTolerance
                    });
                    this.state.tradesProposed++;
                }
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
     * Get momentum/trend statistics
     */
    getMomentumStats() {
        const stats = {};
        for (const key of Object.keys(this.state.priceHistory)) {
            stats[key] = {
                trend: this.state.trend[key] || 'unknown',
                trendStrength: this.state.trendStrength[key]?.toFixed(2) + '%' || 'N/A',
                fastMA: this.state.fastMA[key]?.toFixed(2) || 'N/A',
                slowMA: this.state.slowMA[key]?.toFixed(2) || 'N/A',
                dataPoints: this.state.priceHistory[key]?.length || 0,
                entryPrice: this.state.entryPrice[key]?.toFixed(2) || 'None',
                highSinceEntry: this.state.highSinceEntry[key]?.toFixed(2) || 'None'
            };
        }
        return stats;
    }
}

export default MomentumStrategy;
