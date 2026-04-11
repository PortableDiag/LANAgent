import { logger } from '../../../utils/logger.js';
import { retryOperation } from '../../../utils/retryUtils.js';

/**
 * Base Strategy Class
 * All trading strategies must extend this class
 */
export class BaseStrategy {
    constructor(name, description) {
        this.name = name;
        this.description = description;
        this.enabled = true;

        // Strategy-specific state (isolated per strategy)
        this.state = {
            positions: {},        // Per-network positions
            priceBaselines: {},   // Per-network price baselines (key: network:pair)
            performanceHistory: [],
            tradesExecuted: 0,
            tradesProposed: 0,
            totalPnL: 0,
            dailyPnL: 0,
            lastDecision: null,
            lastExecution: null
        };

        // Default config (can be overridden by subclasses)
        this.config = {
            minTradeValueNative: 0.001,
            maxTradePercentage: 20,
            slippageTolerance: 2,
            retryAttempts: 3
        };
    }

    /**
     * Get strategy metadata
     */
    getInfo() {
        return {
            name: this.name,
            description: this.description,
            enabled: this.enabled,
            config: this.config,
            state: {
                tradesExecuted: this.state.tradesExecuted,
                tradesProposed: this.state.tradesProposed,
                totalPnL: this.state.totalPnL,
                dailyPnL: this.state.dailyPnL,
                positions: this.state.positions
            }
        };
    }

    /**
     * Analyze market and portfolio - must be implemented by subclasses
     * @param {object} marketData - Current market prices and indicators
     * @param {object} portfolio - Current portfolio state
     * @param {string} network - Network being analyzed
     * @param {string} networkMode - 'testnet' or 'mainnet'
     * @returns {object} Analysis result with opportunities
     */
    async analyze(marketData, portfolio, network, networkMode) {
        throw new Error('analyze() must be implemented by subclass');
    }

    /**
     * Make trading decisions based on analysis
     * @param {object} analysis - Result from analyze()
     * @param {object} portfolio - Current portfolio state
     * @returns {array} Array of trade decisions
     */
    async decide(analysis, portfolio) {
        throw new Error('decide() must be implemented by subclass');
    }

    /**
     * Get network-specific baseline key
     * Fixes bug where testnet/mainnet shared baselines
     */
    getBaselineKey(network, pair, networkMode) {
        return `${networkMode}:${network}:${pair}`;
    }

    /**
     * Get or set price baseline for a network/pair
     */
    getBaseline(network, pair, networkMode) {
        const key = this.getBaselineKey(network, pair, networkMode);
        return this.state.priceBaselines[key];
    }

    setBaseline(network, pair, networkMode, price) {
        const key = this.getBaselineKey(network, pair, networkMode);
        this.state.priceBaselines[key] = {
            price,
            timestamp: new Date()
        };
    }

    /**
     * Get position for a network
     */
    getPosition(network) {
        return this.state.positions[network] || {
            inStablecoin: false,
            entryPrice: null,
            stablecoinAmount: 0,
            nativeAmount: 0
        };
    }

    /**
     * Set position for a network
     */
    setPosition(network, position) {
        this.state.positions[network] = {
            ...this.getPosition(network),
            ...position,
            updatedAt: new Date()
        };
    }

    /**
     * Record a trade execution
     */
    recordTrade(trade) {
        this.state.tradesExecuted++;
        this.state.lastExecution = {
            ...trade,
            timestamp: new Date()
        };

        if (trade.pnl) {
            this.state.totalPnL += trade.pnl;
            this.state.dailyPnL += trade.pnl;
        }

        this.state.performanceHistory.push({
            ...trade,
            timestamp: new Date()
        });

        // Keep only last 100 trades in history
        if (this.state.performanceHistory.length > 100) {
            this.state.performanceHistory = this.state.performanceHistory.slice(-100);
        }
    }

    /**
     * Reset daily PnL (called at start of each day)
     */
    resetDailyPnL() {
        this.state.dailyPnL = 0;
    }

    /**
     * Export state for persistence
     */
    exportState() {
        return {
            name: this.name,
            enabled: this.enabled,
            config: this.config,
            state: this.state
        };
    }

    /**
     * Import state from persistence.
     * Uses _configVersion to detect when code defaults have changed.
     * If code version > saved version, code defaults win (prevents stale
     * persisted config from overriding updated defaults).
     */
    importState(data) {
        if (data.enabled !== undefined) this.enabled = data.enabled;
        if (data.config) {
            const codeVersion = this.config._configVersion || 0;
            const savedVersion = data.config._configVersion || 0;
            if (codeVersion > savedVersion) {
                // Code defaults are newer — keep them, but import:
                // 1. Keys not in code defaults (e.g., customScanTokens)
                // 2. Keys where code default is null/undefined but saved has a value
                //    (these are user-set fields like tokenAddress, tokenNetwork, etc.)
                for (const [key, value] of Object.entries(data.config)) {
                    if (this.config[key] === undefined || this.config[key] === null) {
                        if (value !== undefined) {
                            this.config[key] = value;
                        }
                    } else if (!(key in this.config)) {
                        this.config[key] = value;
                    }
                }
                logger.info(`${this.name}: config v${codeVersion} > saved v${savedVersion}, using code defaults`);
            } else {
                this.config = { ...this.config, ...data.config };
            }
        }
        if (data.state) this.state = { ...this.state, ...data.state };
    }

    /**
     * Calculate market volatility using historical price data
     * @param {Array} historicalPrices - Array of historical prices
     * @returns {number} Calculated volatility (standard deviation of returns)
     */
    calculateVolatility(historicalPrices) {
        if (!historicalPrices || historicalPrices.length < 2) {
            logger.warn('[BaseStrategy] Insufficient data to calculate volatility');
            return 0;
        }

        const returns = [];
        for (let i = 1; i < historicalPrices.length; i++) {
            const priceChange = (historicalPrices[i] - historicalPrices[i - 1]) / historicalPrices[i - 1];
            returns.push(priceChange);
        }

        const meanReturn = returns.reduce((acc, val) => acc + val, 0) / returns.length;
        const squaredDiffs = returns.map(r => Math.pow(r - meanReturn, 2));
        const variance = squaredDiffs.reduce((acc, val) => acc + val, 0) / (squaredDiffs.length - 1);
        const volatility = Math.sqrt(variance);

        return volatility;
    }

    /**
     * Execute a trade with retry mechanism
     * @param {function} tradeFunction - The trade function to execute
     * @returns {object} Result of the trade execution
     */
    async executeTradeWithRetry(tradeFunction) {
        try {
            const result = await retryOperation(tradeFunction, { retries: this.config.retryAttempts });
            logger.info(`[${this.name}] Trade executed successfully`);
            return result;
        } catch (error) {
            logger.error(`[${this.name}] Trade execution failed after ${this.config.retryAttempts} retries: ${error.message}`);
            throw error;
        }
    }

    /**
     * Adjust maxTradePercentage based on market volatility
     * Lower volatility = higher trade percentage (more confident)
     * Higher volatility = lower trade percentage (more cautious)
     * @param {number} volatility - Calculated market volatility
     */
    adjustRiskParameters(volatility) {
        const previousPercentage = this.config.maxTradePercentage;

        if (volatility < 0.01) {
            this.config.maxTradePercentage = 30;
        } else if (volatility < 0.05) {
            this.config.maxTradePercentage = 20;
        } else {
            this.config.maxTradePercentage = 10;
        }

        if (previousPercentage !== this.config.maxTradePercentage) {
            logger.info(`[BaseStrategy] Adjusted maxTradePercentage from ${previousPercentage}% to ${this.config.maxTradePercentage}% based on volatility ${(volatility * 100).toFixed(2)}%`);
        }
    }

    /**
     * Dynamic risk assessment based on real-time market data.
     * Adjusts trading parameters dynamically based on current market conditions.
     * @param {object} marketData - Real-time market data with volatility and liquidity
     */
    dynamicRiskAssessment(marketData) {
        const { volatility, liquidity } = marketData;

        // Adjust maxTradePercentage based on volatility
        this.adjustRiskParameters(volatility);

        // Adjust slippageTolerance based on liquidity
        const previousSlippageTolerance = this.config.slippageTolerance;
        if (liquidity > 1000000) {
            this.config.slippageTolerance = 1;
        } else if (liquidity > 500000) {
            this.config.slippageTolerance = 2;
        } else {
            this.config.slippageTolerance = 3;
        }

        if (previousSlippageTolerance !== this.config.slippageTolerance) {
            logger.info(`[BaseStrategy] Adjusted slippageTolerance from ${previousSlippageTolerance} to ${this.config.slippageTolerance} based on liquidity ${liquidity}`);
        }
    }
}

export default BaseStrategy;
