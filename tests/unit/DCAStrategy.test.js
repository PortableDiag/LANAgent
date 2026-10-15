import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DCAStrategy } from '../../src/services/crypto/strategies/DCAStrategy.js';

describe('DCAStrategy - Performance Metrics', () => {
    let strategy;

    beforeEach(() => {
        strategy = new DCAStrategy();
        // Simulate accumulated state for one network
        strategy.state.totalInvested = { bnb: 1000 };
        strategy.state.totalTokensBought = { bnb: 5 };
        strategy.state.averageBuyPrice = { bnb: 200 };
    });

    it('getPerformanceMetrics returns basic metrics without currentPrice', () => {
        const metrics = strategy.getPerformanceMetrics('bnb');
        assert.deepStrictEqual(metrics, {
            network: 'bnb',
            totalInvested: 1000,
            totalTokens: 5,
            averageBuyPrice: 200,
            costBasis: 200
        });
    });

    it('getPerformanceMetrics returns ROI, unrealizedPnL, currentValue when currentPrice provided', () => {
        const metrics = strategy.getPerformanceMetrics('bnb', 250);
        assert.strictEqual(metrics.totalInvested, 1000);
        assert.strictEqual(metrics.totalTokens, 5);
        assert.strictEqual(metrics.averageBuyPrice, 200);
        assert.strictEqual(metrics.currentValue, 1250);
        assert.strictEqual(metrics.unrealizedPnL, 250);
        assert.strictEqual(metrics.ROI, 25);
    });

    it('handles zero total invested (no valuation, no division by zero)', () => {
        strategy.state.totalInvested.matic = 0;
        strategy.state.totalTokensBought.matic = 0;
        strategy.state.averageBuyPrice.matic = 0;
        const metrics = strategy.getPerformanceMetrics('matic', 100);
        assert.strictEqual(metrics.totalInvested, 0);
        // nothing held: no valuation to report, and no division by zero
        assert.strictEqual(metrics.unrealizedPnL, undefined);
        assert.strictEqual(metrics.costBasis, null);
    });

    it('getDCAStats includes performanceMetrics for all networks', () => {
        const stats = strategy.getDCAStats();
        assert.ok(stats.performanceMetrics, 'performanceMetrics should be present');
        assert.ok(stats.performanceMetrics.bnb, 'should contain metrics for bnb');
        const bnbMetrics = stats.performanceMetrics.bnb;
        assert.strictEqual(bnbMetrics.totalInvested, 1000);
        assert.strictEqual(bnbMetrics.totalTokens, 5);
        assert.strictEqual(bnbMetrics.averageBuyPrice, 200);
        // Without currentPrice, ROI should be absent
        assert.strictEqual(bnbMetrics.ROI, undefined);
    });

    it('getPerformanceMetrics defaults to zero for unknown networks', () => {
        const metrics = strategy.getPerformanceMetrics('unknown');
        assert.strictEqual(metrics.totalInvested, 0);
        assert.strictEqual(metrics.totalTokens, 0);
        assert.strictEqual(metrics.averageBuyPrice, 0);
    });

    it('recordDCABuy: cost basis reflects buying more tokens when cheap', () => {
        const s2 = new DCAStrategy();
        s2.recordDCABuy('bsc', 100, 1, 100);   // $100 at $100
        s2.recordDCABuy('bsc', 100, 2, 50);    // $100 at $50
        const m = s2.getPerformanceMetrics('bsc', 50);
        assert.strictEqual(m.totalTokens, 3);
        assert.strictEqual(m.averageBuyPrice, 75);           // plain mean of prices
        assert.ok(Math.abs(m.costBasis - 200 / 3) < 1e-9);    // real price per token
        assert.strictEqual(m.currentValue, 150);
    });

    it('recordDCABuy: an unparseable token amount does not poison the total', () => {
        const s2 = new DCAStrategy();
        s2.recordDCABuy('bsc', 100, undefined, 100);
        s2.recordDCABuy('bsc', 100, '2', 50);
        assert.strictEqual(s2.state.totalTokensBought.bsc, 2);
    });

    it('getInfo exposes the DCA stats', () => {
        const info = strategy.getInfo();
        assert.strictEqual(info.dca.performanceMetrics.bnb.costBasis, 200);
        assert.ok(info.state, 'base info kept');
    });
});
