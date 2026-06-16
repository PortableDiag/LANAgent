/**
 * Trading Strategies Module
 * Exports all strategies and the registry
 */

// Base class
export { BaseStrategy } from './BaseStrategy.js';

// Included strategies
export { DCAStrategy } from './DCAStrategy.js';
export { MeanReversionStrategy } from './MeanReversionStrategy.js';
export { MomentumStrategy } from './MomentumStrategy.js';

// Registry
export { strategyRegistry } from './StrategyRegistry.js';

export default {
    BaseStrategy: (await import('./BaseStrategy.js')).BaseStrategy,
    DCAStrategy: (await import('./DCAStrategy.js')).DCAStrategy,
    MeanReversionStrategy: (await import('./MeanReversionStrategy.js')).MeanReversionStrategy,
    MomentumStrategy: (await import('./MomentumStrategy.js')).MomentumStrategy,
    strategyRegistry: (await import('./StrategyRegistry.js')).strategyRegistry
};
