import { BaseStrategy } from './BaseStrategy.js';
import { logger } from '../../../utils/logger.js';

/**
 * Dollar Cost Averaging (DCA) Strategy
 * Goal: Steadily accumulate native tokens by buying regularly regardless of price
 *
 * Logic:
 * - Buy a fixed amount at regular intervals
 * - Optional: Buy more when price drops significantly (value averaging)
 * - Dynamically adjusts buy intervals based on market volatility
 * - Never sells - pure accumulation strategy
 * - Reduces timing risk and emotional decision-making
 */

export class DCAStrategy extends BaseStrategy {
    constructor() {
        super(
            'dca',
            'Dollar Cost Averaging - Buy regularly to accumulate tokens over time'
        );

        // Strategy-specific config
        this.config = {
            ...this.config,
            // DCA settings
            buyAmountUSD: 10,           // Fixed USD amount per buy
            buyIntervalHours: 24,       // Buy every 24 hours
            valueAveraging: true,       // Enable value averaging (buy more when cheap)
            dipThreshold: -5,           // Buy extra when price down 5%+
            dipMultiplier: 1.5,         // Buy 1.5x on dips
            riskTolerance: 0.5,         // Risk tolerance level (0 to 1)
            // Per-asset settings
            assetSettings: {
                'BNB': { buyAmountUSD: 10, intervalHours: 24 },
                'ETH': { buyAmountUSD: 15, intervalHours: 24 },
                'MATIC': { buyAmountUSD: 5, intervalHours: 48 }
            }
        };

        // DCA-specific state
        this.state = {
            ...this.state,
            lastBuyTime: {},         // Per-network last buy timestamp
            totalInvested: {},       // Per-network total USD invested
            averageBuyPrice: {},     // Per-network average buy price
            buyCount: {}             // Per-network number of buys
        };
    }

    /**
     * Get settings for a specific asset
     */
    getAssetSettings(symbol) {
        const custom = this.config.assetSettings[symbol];
        if (custom) {
            return {
                buyAmountUSD: custom.buyAmountUSD,
                intervalHours: custom.intervalHours
            };
        }
        return {
            buyAmountUSD: this.config.buyAmountUSD,
            intervalHours: this.config.buyIntervalHours
        };
    }

    /**
     * Calculate market volatility index from price history
     */
    calculateVolatilityIndex(marketData, symbol) {
        try {
            const priceHistory = marketData.priceHistory?.[symbol];
            if (!priceHistory || priceHistory.length < 2) {
                return 0;
            }

            const priceChanges = priceHistory.slice(1).map((price, index) => {
                return Math.abs((price - priceHistory[index]) / priceHistory[index]);
            });

            return priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
        } catch (error) {
            logger.error(`Error calculating volatility index for ${symbol}: ${error.message}`);
            return 0;
        }
    }

    /**
     * Adjust buy interval based on market volatility
     */
    adjustBuyInterval(symbol, marketData) {
        const volatilityIndex = this.calculateVolatilityIndex(marketData, symbol);
        const settings = this.getAssetSettings(symbol);

        if (volatilityIndex > 0.05) {
            settings.intervalHours = Math.max(1, settings.intervalHours / 2);
        } else if (volatilityIndex < 0.02) {
            settings.intervalHours = Math.min(48, settings.intervalHours * 2);
        }

        logger.info(`Adjusted buy interval for ${symbol} to ${settings.intervalHours}h (volatility: ${volatilityIndex.toFixed(4)})`);
    }

    /**
     * Adjust buy amount based on market volatility and risk tolerance
     */
    adjustBuyAmount(symbol, marketData) {
        const volatilityIndex = this.calculateVolatilityIndex(marketData, symbol);
        const settings = this.getAssetSettings(symbol);
        const riskAdjustedAmount = settings.buyAmountUSD * (1 - this.config.riskTolerance * volatilityIndex);

        logger.info(`Adjusted buy amount for ${symbol} to $${riskAdjustedAmount.toFixed(2)} (volatility: ${volatilityIndex.toFixed(4)})`);
        return riskAdjustedAmount;
    }

    /**
     * Check if it's time to buy for a network
     */
    isTimeToBy(network) {
        const lastBuy = this.state.lastBuyTime[network];
        if (!lastBuy) return true;

        const settings = this.getAssetSettings(network);
        const intervalMs = settings.intervalHours * 60 * 60 * 1000;
        return Date.now() - new Date(lastBuy).getTime() >= intervalMs;
    }

    /**
     * Analyze market for DCA opportunities
     */
    async analyze(marketData, portfolio, network, networkMode, tokenConfig) {
        const analysis = {
            network,
            networkMode,
            opportunity: null,
            currentPrice: 0,
            timeToBy: false,
            isDip: false,
            buyMultiplier: 1,
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

        // Adjust buy interval based on volatility
        this.adjustBuyInterval(symbol, marketData);

        analysis.timeToBy = this.isTimeToBy(network);

        // Check for dip (value averaging)
        if (this.config.valueAveraging) {
            const baseline = this.getBaseline(network, pricePair, networkMode);
            if (baseline) {
                const priceChange = ((currentPrice - baseline.price) / baseline.price) * 100;
                if (priceChange <= this.config.dipThreshold) {
                    analysis.isDip = true;
                    analysis.buyMultiplier = this.config.dipMultiplier;
                    analysis.priceChange = priceChange;
                }
            } else {
                // Set initial baseline
                this.setBaseline(network, pricePair, networkMode, currentPrice);
            }
        }

        // Determine if we should buy
        if (analysis.timeToBy) {
            const settings = this.getAssetSettings(symbol);
            let buyAmountUSD = this.adjustBuyAmount(symbol, marketData) * analysis.buyMultiplier;

            analysis.opportunity = {
                action: 'dca_buy',
                buyAmountUSD,
                reason: analysis.isDip
                    ? `DCA buy + dip detected (${analysis.priceChange?.toFixed(2)}% down). Buying $${buyAmountUSD.toFixed(2)} of ${symbol}`
                    : `Regular DCA buy. Purchasing $${buyAmountUSD.toFixed(2)} of ${symbol}`,
                confidence: 85, // DCA is a disciplined strategy, high confidence
                currentPrice,
                isDip: analysis.isDip,
                multiplier: analysis.buyMultiplier
            };
        } else {
            const lastBuy = this.state.lastBuyTime[network];
            const settings = this.getAssetSettings(symbol);
            const nextBuyTime = new Date(new Date(lastBuy).getTime() + settings.intervalHours * 60 * 60 * 1000);
            analysis.reason = `Next DCA buy scheduled for ${nextBuyTime.toISOString()}`;
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

            // For DCA, we need stablecoin balance to buy with
            // In testnet, we might use native token value as proxy
            const nativeBalance = parseFloat(balance.native) || 0;

            // Calculate how much native token to buy based on USD amount
            const tokenAmount = opportunity.buyAmountUSD / currentPrice;

            // Check if we have enough to make the trade worthwhile
            if (tokenAmount >= config.minTradeValueNative) {
                decisions.push({
                    strategy: this.name,
                    network,
                    action: 'dca_buy',
                    amountUSD: opportunity.buyAmountUSD,
                    amountToken: tokenAmount.toString(),
                    symbol: balance.symbol,
                    reason: opportunity.reason,
                    confidence: opportunity.confidence,
                    priceAtDecision: currentPrice,
                    isDip: opportunity.isDip,
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
     * Record a DCA buy
     */
    recordDCABuy(network, amountUSD, amountToken, price) {
        // Update last buy time
        this.state.lastBuyTime[network] = new Date();

        // Update total invested
        this.state.totalInvested[network] = (this.state.totalInvested[network] || 0) + amountUSD;

        // Update buy count
        this.state.buyCount[network] = (this.state.buyCount[network] || 0) + 1;

        // Update average buy price
        const prevAvg = this.state.averageBuyPrice[network] || 0;
        const prevCount = (this.state.buyCount[network] || 1) - 1;
        this.state.averageBuyPrice[network] = ((prevAvg * prevCount) + price) / this.state.buyCount[network];

        // Record the trade
        this.recordTrade({
            network,
            action: 'dca_buy',
            amountUSD,
            amountToken,
            price,
            averageBuyPrice: this.state.averageBuyPrice[network],
            totalInvested: this.state.totalInvested[network]
        });
    }

    /**
     * Get DCA statistics
     */
    getDCAStats() {
        return {
            lastBuyTime: this.state.lastBuyTime,
            totalInvested: this.state.totalInvested,
            averageBuyPrice: this.state.averageBuyPrice,
            buyCount: this.state.buyCount,
            config: {
                buyAmountUSD: this.config.buyAmountUSD,
                intervalHours: this.config.buyIntervalHours,
                valueAveraging: this.config.valueAveraging,
                riskTolerance: this.config.riskTolerance
            }
        };
    }
}

export default DCAStrategy;
