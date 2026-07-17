import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeRiskMetrics } from '../../src/models/DailyPnL.js';

test('computeRiskMetrics on a known series matches hand-computed values', () => {
  // Series: +10, -5, +15, 0, -10  → total 10, mean 2
  const m = computeRiskMetrics([10, -5, 15, 0, -10]);

  assert.equal(m.count, 5);
  assert.equal(m.totalNet, 10);
  assert.equal(m.meanDaily, 2);
  // sample variance: ((8^2)+(−7^2)+(13^2)+(−2^2)+(−12^2))/4 = (64+49+169+4+144)/4 = 107.5
  assert.equal(m.stdDev, Number(Math.sqrt(107.5).toFixed(4)));
  // downside dev vs 0-target: sqrt((25+100)/5) = 5
  assert.equal(m.downsideDeviation, 5);
  assert.equal(m.sharpeRatio, Number((2 / Math.sqrt(107.5)).toFixed(4)));
  assert.equal(m.sortinoRatio, Number((2 / 5).toFixed(4)));
  // cumulative: 10, 5, 20, 20, 10 → peak 20, trough after = 10 → $10 drawdown
  assert.equal(m.maxDrawdown, 10);
  // wins 2/5; profit factor 25/15
  assert.equal(m.winRate, 0.4);
  assert.equal(m.profitFactor, Number((25 / 15).toFixed(4)));
});

test('drawdown is dollar-based and defined when the curve starts negative', () => {
  // cumulative: -10, -25, -5 → peak starts at 0 → max drawdown $25
  const m = computeRiskMetrics([-10, -15, 20]);
  assert.equal(m.maxDrawdown, 25);
  assert.ok(Number.isFinite(m.maxDrawdown));
});

test('no losing days yields null profitFactor (not Infinity) and zero downside', () => {
  const m = computeRiskMetrics([1, 2, 3]);
  assert.equal(m.profitFactor, null);
  assert.equal(m.downsideDeviation, 0);
  assert.equal(m.sortinoRatio, 0); // guarded division
  // survives JSON round-trip
  assert.equal(JSON.parse(JSON.stringify(m)).profitFactor, null);
});

test('empty and degenerate inputs return zeros without throwing', () => {
  assert.equal(computeRiskMetrics([]).count, 0);
  assert.equal(computeRiskMetrics(null).count, 0);
  assert.equal(computeRiskMetrics([5]).stdDev, 0); // n=1: no sample variance
  assert.equal(computeRiskMetrics([5]).sharpeRatio, 0);
  assert.equal(computeRiskMetrics([1, NaN, 2]).count, 2); // non-finite filtered
});
