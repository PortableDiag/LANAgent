import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import LPPosition from '../../src/models/LPPosition.js';

// Mongoose documents can be constructed without a DB connection; validation
// only runs on save(), so these are pure unit tests of the instance methods.
function makePosition(overrides = {}) {
  return new LPPosition({
    initialValueBNB: 100,
    currentValueBNB: 150,
    v3: { collectedFees0: '10', collectedFees1: '5' },
    transactions: [],
    ...overrides
  });
}

test('calculateROI returns percentage gain', () => {
  assert.equal(makePosition().calculateROI(), 50);
  assert.equal(makePosition({ initialValueBNB: 0 }).calculateROI(), 0);
});

test('calculateImpermanentLoss uses the standard 50/50 formula', () => {
  // 4x price move → 2*sqrt(4)/(1+4) - 1 = -0.2 → -20%
  assert.ok(Math.abs(makePosition().calculateImpermanentLoss(4) - (-20)) < 1e-9);
  // no divergence → 0
  assert.equal(makePosition().calculateImpermanentLoss(1), 0);
  assert.equal(makePosition().calculateImpermanentLoss(0), 0);
});

test('calculateFeeYield returns per-token fees, not a bogus sum', () => {
  assert.deepStrictEqual(makePosition().calculateFeeYield(), {
    collectedFees0: 10, collectedFees1: 5
  });
});

test('getPerformanceMetrics reports null IL when no price ratio is given', () => {
  const m = makePosition().getPerformanceMetrics();
  assert.equal(m.roi, 50);
  assert.equal(m.impermanentLoss, null);
  assert.deepStrictEqual(m.feeYield, { collectedFees0: 10, collectedFees1: 5 });
});

test('getPerformanceMetrics computes IL when a price ratio is supplied', () => {
  const m = makePosition().getPerformanceMetrics(4);
  assert.ok(Math.abs(m.impermanentLoss - (-20)) < 1e-9);
});

test('optimizationPreferences has correct default values', () => {
  const position = new LPPosition();
  assert.equal(position.optimizationPreferences.maxSlippage, 0.5);
  assert.deepStrictEqual(position.optimizationPreferences.preferredFeeTiers, []);
  assert.equal(position.optimizationPreferences.rebalanceThreshold, 10);
  assert.equal(position.optimizationPreferences.autoCompound, false);
  assert.equal(position.optimizationPreferences.riskTolerance, 'medium');
});

// --- recommendOptimization -------------------------------------------------
//
// The shipped test for this feature only asserted the schema defaults and never
// called the method it was added for. These exercise each recommendation branch
// and its precedence, since the method returns on the first match.

const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// A V3 position with nothing interesting going on: fees all collected, in range,
// no fee-tier preference, ROI under the threshold.
const quietV3 = (overrides = {}) => new LPPosition({
  protocol: 'v3',
  initialValueBNB: 100,
  currentValueBNB: 105, // +5%, below the default rebalanceThreshold of 10
  v3: {
    feeGrowth0: '0', feeGrowth1: '0',
    collectedFees0: '10', collectedFees1: '5',
    feeTier: 500, inRange: true, lastRebalance: daysAgo(1)
  },
  ...overrides
});

test('recommendOptimization declines to advise on non-V3 positions', () => {
  const v2 = new LPPosition({ protocol: 'v2', initialValueBNB: 100, currentValueBNB: 200 });
  const rec = v2.recommendOptimization();

  assert.equal(rec.action, 'none');
  assert.match(rec.reason, /Only V3 positions/);
});

test('recommendOptimization finds nothing to do on a quiet position', () => {
  assert.equal(quietV3().recommendOptimization().action, 'none');
});

test('uncollected fees above 30% of the total suggest collecting', () => {
  const rec = quietV3({
    v3: {
      feeGrowth0: '5', feeGrowth1: '0',       // 5 of 15 total = 33%
      collectedFees0: '10', collectedFees1: '5',
      feeTier: 500, inRange: true, lastRebalance: daysAgo(1)
    }
  }).recommendOptimization();

  assert.equal(rec.action, 'collect_fees');
  assert.equal(rec.details.uncollectedFees0, 5);
});

test('a small uncollected balance is left alone', () => {
  const rec = quietV3({
    v3: {
      feeGrowth0: '1', feeGrowth1: '0',       // 1 of 11 total = 9%
      collectedFees0: '10', collectedFees1: '5',
      feeTier: 500, inRange: true, lastRebalance: daysAgo(1)
    }
  }).recommendOptimization();

  assert.notEqual(rec.action, 'collect_fees');
});

test('fees on one token only do not produce a NaN ratio on the other', () => {
  // token1 has accrued fees, token0 has neither accrued nor collected any, so
  // its ratio is 0/0. NaN must not reach the comparison.
  const rec = quietV3({
    v3: {
      feeGrowth0: '0', feeGrowth1: '9',
      collectedFees0: '0', collectedFees1: '1',
      feeTier: 500, inRange: true, lastRebalance: daysAgo(1)
    }
  }).recommendOptimization();

  assert.equal(rec.action, 'collect_fees', 'token1 is 90% uncollected');
  assert.equal(Number.isNaN(rec.details.uncollectedFees0), false);
});

test('a fee tier outside the preferences suggests the nearest preferred one', () => {
  const rec = quietV3({
    optimizationPreferences: { preferredFeeTiers: [100, 10000] }
  }).recommendOptimization();

  assert.equal(rec.action, 'migrate_fee_tier');
  assert.equal(rec.details.currentFeeTier, 500);
  assert.equal(rec.details.suggestedFeeTier, 100, '500 is nearer 100 than 10000');
});

test('no fee-tier preference means no migration advice', () => {
  // preferredFeeTiers defaults to an empty array, so this must stay opt-in.
  assert.notEqual(quietV3().recommendOptimization().action, 'migrate_fee_tier');
});

test('an out-of-range position untouched for a week suggests rebalancing', () => {
  const rec = quietV3({
    v3: {
      feeGrowth0: '0', feeGrowth1: '0',
      collectedFees0: '10', collectedFees1: '5',
      feeTier: 500, inRange: false, lastRebalance: daysAgo(30)
    }
  }).recommendOptimization();

  assert.equal(rec.action, 'rebalance_position');
  assert.equal(rec.details.daysSinceLastRebalance, 30,
    'the reported figure is rebalance age — time out of range is not recorded anywhere');
});

test('an out-of-range position rebalanced recently is left alone', () => {
  const rec = quietV3({
    v3: {
      feeGrowth0: '0', feeGrowth1: '0',
      collectedFees0: '10', collectedFees1: '5',
      feeTier: 500, inRange: false, lastRebalance: daysAgo(2)
    }
  }).recommendOptimization();

  assert.notEqual(rec.action, 'rebalance_position');
});

test('a never-rebalanced out-of-range position reports null, not Infinity', () => {
  const rec = quietV3({
    v3: {
      feeGrowth0: '0', feeGrowth1: '0',
      collectedFees0: '10', collectedFees1: '5',
      feeTier: 500, inRange: false, lastRebalance: null
    }
  }).recommendOptimization();

  assert.equal(rec.action, 'rebalance_position');
  assert.equal(rec.details.daysSinceLastRebalance, null);
  assert.match(rec.reason, /never been rebalanced/);
});

test('ROI past the threshold suggests compounding', () => {
  const rec = quietV3({ currentValueBNB: 150 }).recommendOptimization(); // +50%

  assert.equal(rec.action, 'rebalance_for_compounding');
  assert.equal(rec.details.currentRoi, 50);
  assert.equal(rec.details.rebalanceThreshold, 10);
});

// --- updatePositionValue ---------------------------------------------------
// The retryOperation wrapper is real; save is stubbed to succeed at once.

test('updatePositionValue - valid v2 calculation and persistence', async () => {
  const pos = new LPPosition({
    protocol: 'v2',
    pairAddress: '0xabc',
    reserveA: '1000',
    reserveB: '2000',
    totalSupply: '10000',
    lpBalance: '500',
    currentValueBNB: 0
  });
  let saveCalls = 0;
  pos.save = async function() {
    saveCalls++;
    return pos;
  };

  const result = await pos.updatePositionValue(0.1, 0.05);

  const expected = (1000 * 500 / 10000 * 0.1) + (2000 * 500 / 10000 * 0.05);
  assert.equal(pos.currentValueBNB, expected);
  assert.equal(result, expected);
  assert.equal(saveCalls, 1, 'save should be called exactly once');
});

test('updatePositionValue - throws for non‑number prices', async () => {
  const pos = new LPPosition({ protocol: 'v2' });
  await assert.rejects(
    () => pos.updatePositionValue('0.1', 0.05),
    /token prices must be numbers/
  );
  await assert.rejects(
    () => pos.updatePositionValue(0.1, 'abc'),
    /token prices must be numbers/
  );
});

test('updatePositionValue - throws for negative prices', async () => {
  const pos = new LPPosition({ protocol: 'v2' });
  await assert.rejects(
    () => pos.updatePositionValue(-0.1, 0.05),
    /token prices cannot be negative/
  );
  await assert.rejects(
    () => pos.updatePositionValue(0.1, -0.05),
    /token prices cannot be negative/
  );
});

test('updatePositionValue - returns current value unchanged for non‑v2 protocols', async () => {
  const pos = new LPPosition({
    protocol: 'v3',
    pairAddress: '0xdef',
    currentValueBNB: 123.45
  });
  // Save should never be invoked for v3; if it is, the test will fail because
  // the real save would try to talk to MongoDB (no connection).
  const result = await pos.updatePositionValue(0.1, 0.05);
  assert.equal(result, 123.45);
  assert.equal(pos.currentValueBNB, 123.45);
});

test('updatePositionValue - sets value to zero when totalSupply is 0', async () => {
  const pos = new LPPosition({
    protocol: 'v2',
    pairAddress: '0xabc',
    reserveA: '1000',
    reserveB: '2000',
    totalSupply: '0',
    lpBalance: '500',
    currentValueBNB: 50
  });
  let saveCalls = 0;
  pos.save = async function() {
    saveCalls++;
    return pos;
  };

  const result = await pos.updatePositionValue(0.1, 0.05);
  assert.equal(pos.currentValueBNB, 0);
  assert.equal(result, 0);
  assert.equal(saveCalls, 1);
});

test('updatePositionValue - sets value to zero when lpBalance is 0', async () => {
  const pos = new LPPosition({
    protocol: 'v2',
    pairAddress: '0xabc',
    reserveA: '1000',
    reserveB: '2000',
    totalSupply: '10000',
    lpBalance: '0',
    currentValueBNB: 50
  });
  let saveCalls = 0;
  pos.save = async function() {
    saveCalls++;
    return pos;
  };

  const result = await pos.updatePositionValue(0.1, 0.05);
  assert.equal(pos.currentValueBNB, 0);
  assert.equal(result, 0);
  assert.equal(saveCalls, 1);
});

test('updatePositionValue - rejects NaN / Infinity prices', async () => {
  const pos = new LPPosition({ protocol: 'v2' });
  await assert.rejects(() => pos.updatePositionValue(NaN, 0.05), /token prices must be numbers/);
  await assert.rejects(() => pos.updatePositionValue(0.1, Infinity), /token prices must be numbers/);
});

// --- lpManager reserve mapping + WBNB-pair valuation -------------------------
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const TOKEN = '0x0000000000000000000000000000000000000001'; // sorts before WBNB

test('reservesForPosition maps pair-order reserves onto tokenA/tokenB', async () => {
  const { reservesForPosition } = await import('../../src/services/crypto/lpManager.js');
  const info = { token0: TOKEN, token1: WBNB, reserve0: '1000', reserve1: '5' };
  // tokenA is token0: unchanged
  assert.deepEqual(reservesForPosition({ tokenA: { address: TOKEN } }, info), { reserveA: '1000', reserveB: '5' });
  // tokenA is token1: swapped (the old code stored reserve0 as reserveA regardless)
  assert.deepEqual(reservesForPosition({ tokenA: { address: WBNB } }, info), { reserveA: '5', reserveB: '1000' });
});

test('valuePositionInBNB prices a WBNB pair from its own reserves', async () => {
  const { valuePositionInBNB } = await import('../../src/services/crypto/lpManager.js');
  const pos = new LPPosition({
    protocol: 'v2', network: 'bsc', pairAddress: '0xpair',
    tokenA: { address: WBNB, symbol: 'WBNB' }, tokenB: { address: TOKEN, symbol: 'TKN' },
    reserveA: '5', reserveB: '1000', totalSupply: '100', lpBalance: '10'
  });
  pos.save = async () => pos;
  const v = await valuePositionInBNB(pos, 'bsc');
  // 10% share: 0.5 WBNB + 100 TKN at 0.005 BNB each = 1 BNB (both sides equal, as in any V2 pool)
  assert.ok(Math.abs(v - 1) < 1e-12, `value ${v}`);
});

test('valuePositionInBNB declines pairs without WBNB and non-v2 positions', async () => {
  const { valuePositionInBNB } = await import('../../src/services/crypto/lpManager.js');
  const base = { network: 'bsc', pairAddress: '0xp', reserveA: '1', reserveB: '1', totalSupply: '1', lpBalance: '1' };
  const noNative = new LPPosition({ ...base, protocol: 'v2', tokenA: { address: TOKEN }, tokenB: { address: '0x0000000000000000000000000000000000000002' } });
  const v3 = new LPPosition({ ...base, protocol: 'v3', tokenA: { address: WBNB }, tokenB: { address: TOKEN } });
  assert.equal(await valuePositionInBNB(noNative, 'bsc'), null);
  assert.equal(await valuePositionInBNB(v3, 'bsc'), null);
});
