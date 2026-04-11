/**
 * Trading Strategies Module
 * Exports all strategies and the registry
 */

// Base class
export { BaseStrategy } from './BaseStrategy.js';

// Core strategies
export { NativeMaximizerStrategy } from './NativeMaximizerStrategy.js';
export { DCAStrategy } from './DCAStrategy.js';

// Advanced strategies
export { GridTradingStrategy } from './GridTradingStrategy.js';
export { MeanReversionStrategy } from './MeanReversionStrategy.js';
export { VolatilityAdjustedStrategy } from './VolatilityAdjustedStrategy.js';
export { MomentumStrategy } from './MomentumStrategy.js';
export { DollarMaximizerStrategy } from './DollarMaximizerStrategy.js';
export { TokenTraderStrategy } from './TokenTraderStrategy.js';

// Registry
export { strategyRegistry } from './StrategyRegistry.js';

export default {
    BaseStrategy: (await import('./BaseStrategy.js')).BaseStrategy,
    NativeMaximizerStrategy: (await import('./NativeMaximizerStrategy.js')).NativeMaximizerStrategy,
    DCAStrategy: (await import('./DCAStrategy.js')).DCAStrategy,
    GridTradingStrategy: (await import('./GridTradingStrategy.js')).GridTradingStrategy,
    MeanReversionStrategy: (await import('./MeanReversionStrategy.js')).MeanReversionStrategy,
    VolatilityAdjustedStrategy: (await import('./VolatilityAdjustedStrategy.js')).VolatilityAdjustedStrategy,
    MomentumStrategy: (await import('./MomentumStrategy.js')).MomentumStrategy,
    DollarMaximizerStrategy: (await import('./DollarMaximizerStrategy.js')).DollarMaximizerStrategy,
    TokenTraderStrategy: (await import('./TokenTraderStrategy.js')).TokenTraderStrategy,
    strategyRegistry: (await import('./StrategyRegistry.js')).strategyRegistry
};
