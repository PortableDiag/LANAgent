/**
 * Mean Reversion Strategy
 * Goal: Profit from price returning to its average after deviations
 *
 * Logic:
 * - Calculate moving average from historical prices
 * - Buy when price drops significantly below the moving average
 * - Sell when price rises significantly above the moving average
 * - Based on the principle that prices tend to revert to the mean
 */
import { BaseStrategy } from './BaseStrategy.js';
import { logger } from '../../../utils/logger.js';

export class MeanReversionStrategy extends BaseStrategy {
    constructor() {
        super(
            'mean_reversion',
            'Mean Reversion - Buy below average, sell above average'
        );

        // Strategy-specific config
        this.config = {
            ...this.config,
            // Mean reversion settings
            maPeriodHours: 24,           // Moving average period in hours (default)
            buyDeviationPercent: -5,     // Buy when X% below MA
            sellDeviationPercent: 5,     // Sell when X% above MA
            minDataPoints: 6,            // Minimum data points before trading
            volatilityThreshold: 0.02,   // Volatility threshold for MA adjustment
            maxMAPeriodHours: 48,        // Maximum MA period in hours
            minMAPeriodHours: 6,         // Minimum MA period in hours
            riskAdjustmentFactor: 0.1,   // Factor to adjust risk parameters
            // Per-asset settings
            assetSettings: {
                'BNB': { buyDeviation: -5, sellDeviation: 5 },
                'ETH': { buyDeviation: -4, sellDeviation: 4 },   // ETH less volatile
                'MATIC': { buyDeviation: -6, sellDeviation: 6 }  // MATIC more volatile
            }
        };

        // Mean reversion specific state
        this.state = {
            ...this.state,
            priceHistory: {},      // Historical prices per network/pair
            movingAverages: {},    // Calculated MAs
            lastUpdate: {},        // Last update time per network
            volatility: {},        // Volatility per network/pair
            maPeriods: {},         // Per-pair MA periods (dynamic)
            riskParameters: {}     // Dynamic risk parameters per network/pair
        };
    }

    /**
     * Get settings for a specific asset
     */
    getAssetSettings(symbol) {
        const custom = this.config.assetSettings[symbol];
        if (custom) {
            return {
                buyDeviation: custom.buyDeviation,
                sellDeviation: custom.sellDeviation
            };
        }
        return {
            buyDeviation: this.config.buyDeviationPercent,
            sellDeviation: this.config.sellDeviationPercent
        };
    }

    /**
     * Get MA period for a specific pair (supports per-pair dynamic adjustment)
     */
    getMAPeriod(key) {
        return this.state.maPeriods[key] || this.config.maPeriodHours;
    }

    /**
     * Add price to history
     */
    addPriceToHistory(network, pair, networkMode, price) {
        const key = this.getBaselineKey(network, pair, networkMode);

        if (!this.state.priceHistory[key]) {
            this.state.priceHistory[key] = [];
        }

        // Add new price with timestamp
        this.state.priceHistory[key].push({
            price,
            timestamp: Date.now()
        });

        // Keep only prices within the MA period (use per-pair period)
        const maPeriod = this.getMAPeriod(key);
        const cutoffTime = Date.now() - (maPeriod * 60 * 60 * 1000);
        this.state.priceHistory[key] = this.state.priceHistory[key].filter(
            p => p.timestamp > cutoffTime
        );

        this.state.lastUpdate[key] = Date.now();

        // Update volatility and adjust MA period dynamically
        this.updateVolatility(network, pair, networkMode);
    }

    /**
     * Update volatility based on recent price changes
     */
    updateVolatility(network, pair, networkMode) {
        const key = this.getBaselineKey(network, pair, networkMode);
        const history = this.state.priceHistory[key];

        if (!history || history.length < 2) {
            this.state.volatility[key] = 0;
            return;
        }

        const priceChanges = history.slice(1).map((entry, index) => {
            const prevPrice = history[index].price;
            return Math.abs((entry.price - prevPrice) / prevPrice);
        });

        const avgChange = priceChanges.reduce((acc, change) => acc + change, 0) / priceChanges.length;
        this.state.volatility[key] = avgChange;

        // Adjust MA period based on volatility (per-pair)
        this.adjustMAPeriod(key, avgChange);

        // Adjust risk parameters based on volatility
        this.adjustRiskParameters(key, avgChange);
    }

    /**
     * Adjust moving average period based on volatility (per-pair)
     */
    adjustMAPeriod(key, volatility) {
        const currentPeriod = this.getMAPeriod(key);
        let newMAPeriod = currentPeriod;

        if (volatility > this.config.volatilityThreshold) {
            // High volatility: shorten period to react faster
            newMAPeriod = Math.max(this.config.minMAPeriodHours, currentPeriod / 1.5);
        } else if (volatility < this.config.volatilityThreshold / 2) {
            // Low volatility: lengthen period to smooth noise
            newMAPeriod = Math.min(this.config.maxMAPeriodHours, currentPeriod * 1.25);
        }

        newMAPeriod = Math.round(newMAPeriod);
        if (newMAPeriod !== currentPeriod) {
            logger.info(`Adjusting MA period for ${key} from ${currentPeriod} to ${newMAPeriod} hours (volatility: ${(volatility * 100).toFixed(2)}%)`);
            this.state.maPeriods[key] = newMAPeriod;
        }
    }

    /**
     * Adjust risk parameters based on volatility
     */
    adjustRiskParameters(key, volatility) {
        const riskAdjustment = 1 + (volatility * this.config.riskAdjustmentFactor);
        this.state.riskParameters[key] = {
            tradeSizeMultiplier: Math.min(2, riskAdjustment),
            stopLossMultiplier: Math.max(0.5, 1 / riskAdjustment),
            profitTakingMultiplier: Math.min(2, riskAdjustment)
        };
        logger.info(`Adjusted risk parameters for ${key}: ${JSON.stringify(this.state.riskParameters[key])}`);
    }

    /**
     * Calculate moving average
     */
    calculateMA(network, pair, networkMode) {
        const key = this.getBaselineKey(network, pair, networkMode);
        const history = this.state.priceHistory[key];

        if (!history || history.length < this.config.minDataPoints) {
            return null;
        }

        const sum = history.reduce((acc, p) => acc + p.price, 0);
        const ma = sum / history.length;

        this.state.movingAverages[key] = {
            value: ma,
            dataPoints: history.length,
            calculatedAt: Date.now()
        };

        return ma;
    }

    /**
     * Analyze market for mean reversion opportunities
     */
    async analyze(marketData, portfolio, network, networkMode, tokenConfig) {
        const analysis = {
            network,
            networkMode,
            opportunity: null,
            currentPrice: 0,
            movingAverage: null,
            deviation: null,
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

        // Add current price to history
        this.addPriceToHistory(network, pricePair, networkMode, currentPrice);

        // Calculate moving average
        const ma = this.calculateMA(network, pricePair, networkMode);

        if (!ma) {
            const key = this.getBaselineKey(network, pricePair, networkMode);
            const dataPoints = this.state.priceHistory[key]?.length || 0;
            analysis.reason = `Collecting data: ${dataPoints}/${this.config.minDataPoints} points needed`;
            return analysis;
        }

        analysis.movingAverage = ma;

        // Calculate deviation from MA
        const deviation = ((currentPrice - ma) / ma) * 100;
        analysis.deviation = deviation;

        // Get position and asset settings
        const position = this.getPosition(network);
        const settings = this.getAssetSettings(symbol);

        // Determine opportunity
        if (!position.inStablecoin && deviation >= settings.sellDeviation) {
            // Price is significantly above MA - sell signal
            analysis.opportunity = {
                action: 'sell_to_stablecoin',
                reason: `${symbol} is ${deviation.toFixed(2)}% above MA ($${ma.toFixed(2)}). Mean reversion sell signal.`,
                confidence: Math.min(90, 60 + Math.abs(deviation) * 2),
                currentPrice,
                movingAverage: ma,
                deviation
            };
        } else if (deviation <= settings.buyDeviation) {
            // Price is significantly below MA - buy signal
            if (position.inStablecoin) {
                analysis.opportunity = {
                    action: 'buy_native',
                    reason: `${symbol} is ${Math.abs(deviation).toFixed(2)}% below MA ($${ma.toFixed(2)}). Mean reversion buy signal.`,
                    confidence: Math.min(90, 60 + Math.abs(deviation) * 2),
                    currentPrice,
                    movingAverage: ma,
                    deviation
                };
            } else {
                // Not in stablecoin but price is low - consider accumulating
                analysis.opportunity = {
                    action: 'accumulate',
                    reason: `${symbol} is ${Math.abs(deviation).toFixed(2)}% below MA. Good accumulation opportunity.`,
                    confidence: Math.min(85, 55 + Math.abs(deviation) * 2),
                    currentPrice,
                    movingAverage: ma,
                    deviation
                };
            }
        } else {
            // Price near MA - no clear signal
            analysis.reason = `Price within normal range. ${deviation.toFixed(2)}% from MA ($${ma.toFixed(2)}). Need ${settings.buyDeviation}% or +${settings.sellDeviation}% deviation.`;
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
            const riskParams = this.state.riskParameters[this.getBaselineKey(network, balance.symbol, 'default')] || {};

            if (opportunity.action === 'sell_to_stablecoin' && nativeBalance > config.minTradeValueNative) {
                // Sell a portion based on deviation strength
                const deviationStrength = Math.min(1, Math.abs(analysis.deviation) / 10);
                const tradeAmount = Math.min(
                    nativeBalance * (config.maxTradePercentage / 100) * deviationStrength * (riskParams.tradeSizeMultiplier || 1),
                    nativeBalance * 0.9
                );

                if (tradeAmount >= config.minTradeValueNative) {
                    decisions.push({
                        strategy: this.name,
                        network,
                        action: 'sell_to_stablecoin',
                        amount: tradeAmount.toString(),
                        symbol: balance.symbol,
                        reason: opportunity.reason,
                        confidence: opportunity.confidence,
                        priceAtDecision: currentPrice,
                        movingAverage: analysis.movingAverage,
                        deviation: analysis.deviation,
                        expectedSlippage: config.slippageTolerance * (riskParams.stopLossMultiplier || 1)
                    });
                    this.state.tradesProposed++;
                }
            } else if (opportunity.action === 'buy_native' && position.stablecoinAmount > 0) {
                decisions.push({
                    strategy: this.name,
                    network,
                    action: 'buy_native',
                    amount: position.stablecoinAmount.toString(),
                    symbol: balance.symbol,
                    reason: opportunity.reason,
                    confidence: opportunity.confidence,
                    priceAtDecision: currentPrice,
                    movingAverage: analysis.movingAverage,
                    deviation: analysis.deviation,
                    expectedSlippage: config.slippageTolerance * (riskParams.profitTakingMultiplier || 1)
                });
                this.state.tradesProposed++;
            } else if (opportunity.action === 'accumulate' && nativeBalance > config.minTradeValueNative * 2) {
                // Accumulation - use a small portion
                const tradeAmount = nativeBalance * 0.05 * (riskParams.tradeSizeMultiplier || 1); // 5% accumulation
                if (tradeAmount >= config.minTradeValueNative) {
                    decisions.push({
                        strategy: this.name,
                        network,
                        action: 'accumulate',
                        amount: tradeAmount.toString(),
                        symbol: balance.symbol,
                        reason: opportunity.reason,
                        confidence: opportunity.confidence,
                        priceAtDecision: currentPrice,
                        movingAverage: analysis.movingAverage,
                        deviation: analysis.deviation,
                        expectedSlippage: config.slippageTolerance * (riskParams.stopLossMultiplier || 1)
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
     * Get mean reversion statistics
     */
    getMRStats() {
        const stats = {};
        for (const [key, history] of Object.entries(this.state.priceHistory)) {
            const ma = this.state.movingAverages[key];
            stats[key] = {
                dataPoints: history.length,
                movingAverage: ma?.value?.toFixed(2) || 'N/A',
                lastUpdate: this.state.lastUpdate[key]
                    ? new Date(this.state.lastUpdate[key]).toISOString()
                    : 'Never',
                volatility: this.state.volatility[key]?.toFixed(4) || 'N/A',
                maPeriodHours: this.getMAPeriod(key),
                riskParameters: this.state.riskParameters[key] || {}
            };
        }
        return stats;
    }
}

export default MeanReversionStrategy;
