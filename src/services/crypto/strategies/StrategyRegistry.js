import { logger as baseLogger } from '../../../utils/logger.js';
import { DCAStrategy } from './DCAStrategy.js';
import { MeanReversionStrategy } from './MeanReversionStrategy.js';
import { MomentumStrategy } from './MomentumStrategy.js';

const logger = baseLogger.child({ service: 'strategy-registry' });

class StrategyRegistry {
    constructor() {
        this.strategies = new Map();
        this.activeStrategy = null;
        this.secondaryStrategy = null;
        this.initialized = false;

        // Multi-token trader instances: Map<lowercaseAddress, TokenTraderStrategy>
        this.tokenTraders = new Map();

        // Register built-in strategies
        this.registerBuiltInStrategies();
    }

    /**
     * Register all built-in strategies
     */
    registerBuiltInStrategies() {
        this.register(new DCAStrategy());
        this.register(new MeanReversionStrategy());
        this.register(new MomentumStrategy());

        logger.info(`Registered ${this.strategies.size} built-in strategies`);
    }

    /**
     * Register a strategy
     */
    register(strategy) {
        if (!strategy.name) {
            throw new Error('Strategy must have a name');
        }

        this.strategies.set(strategy.name, strategy);
        logger.debug(`Registered strategy: ${strategy.name}`);
    }

    /**
     * Get a strategy by name
     */
    get(name) {
        return this.strategies.get(name);
    }

    /**
     * Get the active strategy
     */
    getActive() {
        return this.activeStrategy;
    }

    /**
     * Set the active strategy
     */
    setActive(name) {
        const strategy = this.strategies.get(name);
        if (!strategy) {
            throw new Error(`Strategy not found: ${name}`);
        }

        if (!this.areDependenciesActive(strategy)) {
            throw new Error(`Cannot activate strategy ${name} because its dependencies are not active`);
        }

        const previousStrategy = this.activeStrategy?.name;
        this.activeStrategy = strategy;

        logger.info(`Active strategy changed: ${previousStrategy || 'none'} → ${name}`);

        return {
            success: true,
            previousStrategy,
            currentStrategy: name,
            strategyInfo: strategy.getInfo()
        };
    }

    /**
     * Get the secondary strategy
     */
    getSecondary() {
        return this.secondaryStrategy;
    }

    /**
     * Set a secondary strategy (runs alongside the primary)
     */
    setSecondary(name) {
        if (!name) {
            const previous = this.secondaryStrategy?.name;
            this.secondaryStrategy = null;
            logger.info(`Secondary strategy cleared (was: ${previous || 'none'})`);
            return { success: true, previousStrategy: previous, currentStrategy: null };
        }

        const strategy = this.strategies.get(name);
        if (!strategy) {
            throw new Error(`Strategy not found: ${name}`);
        }

        if (!this.areDependenciesActive(strategy)) {
            throw new Error(`Cannot set secondary strategy ${name} because its dependencies are not active`);
        }

        const previousStrategy = this.secondaryStrategy?.name;
        this.secondaryStrategy = strategy;

        logger.info(`Secondary strategy set: ${previousStrategy || 'none'} → ${name}`);
        return {
            success: true,
            previousStrategy,
            currentStrategy: name,
            strategyInfo: strategy.getInfo()
        };
    }

    // ==================== Multi-Token Trader Methods ====================

    /**
     * Add or update a token trader instance for a specific token address
     */
    addTokenTrader(address, config) {
        const key = address.toLowerCase();
        let instance = this.tokenTraders.get(key);
        if (!instance) {
            // The token-trader strategy is not part of this distribution. This method used to
            // construct it directly, which was an unbound identifier here and therefore a
            // guaranteed ReferenceError the first time the route was called — a crash rather
            // than an answer. Refuse clearly instead.
            throw new Error(
                'The token-trader strategy is not included in this distribution. ' +
                'Register a strategy with registerStrategy() and use it via setActiveStrategy(), ' +
                'or see docs/guides/CUSTOM-STRATEGIES.md to implement your own.'
            );
        }
        // Copy shared watchlist from the base token_trader, when one is registered
        const baseTrader = this.strategies.get('token_trader');
        if (baseTrader?.config?.tokenWatchlist) {
            instance.config.tokenWatchlist = baseTrader.config.tokenWatchlist;
        }
        instance.configure(config);
        return instance;
    }

    /**
     * Get a token trader instance by address
     */
    getTokenTrader(address) {
        return this.tokenTraders.get(address.toLowerCase());
    }

    /**
     * Get all active token trader instances
     */
    getAllTokenTraders() {
        return this.tokenTraders;
    }

    /**
     * Remove a token trader instance
     */
    removeTokenTrader(address) {
        const key = address.toLowerCase();
        const instance = this.tokenTraders.get(key);
        if (instance) {
            logger.info(`Token trader instance removed: ${instance.config.tokenSymbol || address}`);
            this.tokenTraders.delete(key);
            return true;
        }
        return false;
    }

    /**
     * List all available strategies
     */
    list() {
        const list = [];
        for (const [name, strategy] of this.strategies) {
            list.push({
                name,
                description: strategy.description,
                enabled: strategy.enabled,
                isActive: this.activeStrategy?.name === name,
                dependencies: strategy.dependencies || [],
                stats: {
                    tradesExecuted: strategy.state.tradesExecuted,
                    totalPnL: strategy.state.totalPnL
                }
            });
        }
        return list;
    }

    /**
     * Get strategy info
     */
    getInfo(name) {
        const strategy = this.strategies.get(name);
        if (!strategy) {
            throw new Error(`Strategy not found: ${name}`);
        }
        return strategy.getInfo();
    }

    /**
     * Update strategy config
     */
    updateConfig(name, config) {
        const strategy = this.strategies.get(name);
        if (!strategy) {
            throw new Error(`Strategy not found: ${name}`);
        }

        // Guard: preserve system tokens in watchlist for token_trader
        if (name === 'token_trader' && config.tokenWatchlist && strategy.constructor.preserveSystemTokens) {
            config.tokenWatchlist = strategy.constructor.preserveSystemTokens(
                strategy.config.tokenWatchlist, config.tokenWatchlist
            );
        }

        strategy.config = { ...strategy.config, ...config };
        logger.info(`Updated config for strategy: ${name}`, config);

        return {
            success: true,
            strategy: name,
            config: strategy.config
        };
    }

    /**
     * Enable/disable a strategy
     */
    setEnabled(name, enabled) {
        const strategy = this.strategies.get(name);
        if (!strategy) {
            throw new Error(`Strategy not found: ${name}`);
        }

        strategy.enabled = enabled;
        logger.info(`Strategy ${name} ${enabled ? 'enabled' : 'disabled'}`);

        return { success: true, strategy: name, enabled };
    }

    /**
     * Export all strategy states for persistence
     */
    exportState() {
        const states = {};
        for (const [name, strategy] of this.strategies) {
            states[name] = strategy.exportState();
        }
        // Export multi-token trader instances
        const tokenTraderStates = {};
        for (const [address, instance] of this.tokenTraders) {
            tokenTraderStates[address] = instance.exportState();
        }

        return {
            activeStrategy: this.activeStrategy?.name,
            secondaryStrategy: this.secondaryStrategy?.name || null,
            strategies: states,
            tokenTraders: Object.keys(tokenTraderStates).length > 0 ? tokenTraderStates : undefined
        };
    }

    /**
     * Import strategy states from persistence
     */
    importState(data) {
        if (!data) return;

        // Import individual strategy states
        if (data.strategies) {
            for (const [name, state] of Object.entries(data.strategies)) {
                const strategy = this.strategies.get(name);
                if (strategy) {
                    strategy.importState(state);
                    logger.debug(`Imported state for strategy: ${name}`);
                }
            }
        }

        // Set active strategy
        if (data.activeStrategy) {
            try {
                this.setActive(data.activeStrategy);
            } catch (error) {
                logger.warn(`Could not restore active strategy: ${data.activeStrategy}`);
                // Default to native_maximizer
                this.setActive('native_maximizer');
            }
        } else {
            // Default to native_maximizer
            this.setActive('native_maximizer');
        }

        // Restore secondary strategy
        if (data.secondaryStrategy) {
            try {
                this.setSecondary(data.secondaryStrategy);
            } catch (error) {
                logger.warn(`Could not restore secondary strategy: ${data.secondaryStrategy}`);
            }
        }

        // Multi-token trader instances are not restorable in this distribution: the strategy
        // they belong to is not included. Both branches here previously constructed it by
        // name, which is unbound in this build — so importing any saved state that contained
        // token traders threw, taking the whole restore down with it. Skip that section and
        // say so, rather than losing every other strategy's state to it.
        if (data.tokenTraders && Object.keys(data.tokenTraders).length > 0) {
            logger.warn(
                `Skipping ${Object.keys(data.tokenTraders).length} saved token-trader instance(s): ` +
                'that strategy is not included in this distribution. All other strategy state was restored.'
            );
        }

        this.initialized = true;
        logger.info('Strategy registry state imported');
    }

    /**
     * Get performance comparison across strategies
     */
    getPerformanceComparison() {
        const comparison = [];
        for (const [name, strategy] of this.strategies) {
            comparison.push({
                name,
                description: strategy.description,
                isActive: this.activeStrategy?.name === name,
                dependencies: strategy.dependencies || [],
                performance: {
                    tradesExecuted: strategy.state.tradesExecuted,
                    tradesProposed: strategy.state.tradesProposed,
                    successRate: strategy.state.tradesProposed > 0
                        ? ((strategy.state.tradesExecuted / strategy.state.tradesProposed) * 100).toFixed(1) + '%'
                        : 'N/A',
                    totalPnL: strategy.state.totalPnL,
                    dailyPnL: strategy.state.dailyPnL,
                    positionsHeld: Object.keys(strategy.state.positions).length
                }
            });
        }
        return comparison;
    }

    /**
     * Reset daily PnL for all strategies
     */
    resetAllDailyPnL() {
        for (const strategy of this.strategies.values()) {
            strategy.resetDailyPnL();
        }
        logger.info('Reset daily PnL for all strategies');
    }

    /**
     * Get strategy names
     */
    getNames() {
        return Array.from(this.strategies.keys());
    }

    /**
     * Check if all dependencies of a strategy are active
     */
    areDependenciesActive(strategy) {
        if (!strategy.dependencies || strategy.dependencies.length === 0) {
            return true;
        }
        return strategy.dependencies.every(dep => {
            const depStrategy = this.strategies.get(dep);
            return depStrategy && depStrategy.enabled;
        });
    }

    /**
     * Generate a per-strategy performance report. Pulls the trade-derived
     * metrics implemented on BaseStrategy (calculateAverageTradeDuration,
     * calculateMaximumDrawdown, calculateSharpeRatio). Strategies without
     * those methods (custom non-BaseStrategy subclasses) are reported with
     * nulls rather than throwing, so the report is safe to call during
     * mixed-registry boot states.
     */
    generatePerformanceReport({ log = false } = {}) {
        const reports = [];
        for (const [name, strategy] of this.strategies) {
            const safeCall = (fn) => {
                try { return typeof fn === 'function' ? fn.call(strategy) : null; }
                catch { return null; }
            };
            const report = {
                name,
                enabled: !!strategy.enabled,
                tradesExecuted: strategy.state?.tradesExecuted ?? 0,
                totalPnL: strategy.state?.totalPnL ?? 0,
                averageTradeDuration: safeCall(strategy.calculateAverageTradeDuration),
                maximumDrawdown: safeCall(strategy.calculateMaximumDrawdown),
                sharpeRatio: safeCall(strategy.calculateSharpeRatio)
            };
            reports.push(report);
            if (log) logger.info(`Performance report for ${name}:`, report);
        }
        return reports;
    }
}

// Export singleton instance
export const strategyRegistry = new StrategyRegistry();
export default strategyRegistry;