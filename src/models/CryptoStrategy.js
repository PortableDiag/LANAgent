import mongoose from 'mongoose';

const cryptoStrategySchema = new mongoose.Schema({
    type: {
        type: String,
        required: true,
        enum: ['config', 'decision', 'execution'],
        index: true
    },
    networkMode: {
        type: String,
        enum: ['testnet', 'mainnet'],
        default: 'testnet'
    },
    config: {
        enabled: { type: Boolean, default: false },
        intervalMinutes: { type: Number, default: 60 },
        maxTradePercentage: { type: Number, default: 10 },
        dailyLossLimit: { type: Number, default: 5 },
        slippageTolerance: { type: Number, default: 1 },
        minTradeValueUSD: { type: Number, default: 1 },
        strategies: [{ type: String }],
        targetAllocations: { type: mongoose.Schema.Types.Mixed },
        watchlist: [{ type: String }],
        autoExecute: { type: Boolean, default: true },
        emergencyStop: { type: Boolean, default: false }
    },
    state: {
        currentStrategy: String,
        lastDecision: mongoose.Schema.Types.Mixed,
        lastExecution: mongoose.Schema.Types.Mixed,
        performanceHistory: [mongoose.Schema.Types.Mixed],
        dailyPnL: { type: Number, default: 0 },
        totalPnL: { type: Number, default: 0 },
        tradesExecuted: { type: Number, default: 0 },
        tradesProposed: { type: Number, default: 0 },
        // Price baselines for strategy decisions - CRITICAL for stop-loss and trend tracking
        // Structure: { 'ETH/USD': { price, timestamp, highWatermark, highWatermarkTime } }
        priceBaselines: { type: mongoose.Schema.Types.Mixed, default: {} },
        // Position tracking - whether in stablecoin or native asset
        positions: { type: mongoose.Schema.Types.Mixed, default: {} }
    },
    // For decision/execution records
    decision: {
        action: String,
        asset: String,
        amount: Number,
        direction: String,
        reason: String,
        confidence: Number
    },
    execution: {
        status: String,
        network: String,
        txHash: String,
        error: String
    },
    marketSnapshot: {
        prices: mongoose.Schema.Types.Mixed,
        newsCount: Number
    },
    portfolioSnapshot: mongoose.Schema.Types.Mixed,
    // Strategy registry state - persists active strategy and per-strategy state across restarts
    strategyRegistry: {
        activeStrategy: String,
        strategies: mongoose.Schema.Types.Mixed  // Per-strategy state data
    }
}, {
    timestamps: true
});

// Index for querying recent decisions
cryptoStrategySchema.index({ type: 1, createdAt: -1 });

export default mongoose.model('CryptoStrategy', cryptoStrategySchema);
