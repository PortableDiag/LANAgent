import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeIndicators } from '../../src/services/crypto/indicators/TimeIndicators.js';

// Helper: invoke an indicator through the real public call path.
// TimeIndicators exposes getIndicators() (a Map of name -> async fn) and
// getMetadata(name). There is no getIndicatorValue() method.
async function call(indicators, name) {
  const fn = indicators.getIndicators().get(name);
  assert.ok(fn, `indicator "${name}" should be registered`);
  return fn();
}

test('TimeIndicators - multi_market_session_indicator returns a valid object shape', async () => {
  const indicators = new TimeIndicators();
  const result = await call(indicators, 'multi_market_session_indicator');

  assert.ok(result && typeof result === 'object');
  assert.ok(['active', 'inactive', 'closed'].includes(result.status));
  assert.ok(Array.isArray(result.active_markets));
  // Every reported active market must be one of the known names.
  for (const m of result.active_markets) {
    assert.ok(['Asian', 'European', 'US'].includes(m), `unexpected market: ${m}`);
  }
});

test('TimeIndicators - active_market_count scalar companion returns a number 0-3', async () => {
  const indicators = new TimeIndicators();
  const count = await call(indicators, 'active_market_count');

  assert.strictEqual(typeof count, 'number');
  assert.ok(Number.isInteger(count));
  assert.ok(count >= 0 && count <= 3, `count out of range: ${count}`);
});

test('TimeIndicators - extended_market_period scalar companion returns a known string', async () => {
  const indicators = new TimeIndicators();
  const period = await call(indicators, 'extended_market_period');

  assert.strictEqual(typeof period, 'string');
  assert.ok(
    ['pre_market', 'regular_market', 'after_hours', 'closed', 'weekend'].includes(period),
    `unexpected period: ${period}`
  );
});

test('TimeIndicators - extended_market_hours object exposes the same period as its scalar companion', async () => {
  const indicators = new TimeIndicators();
  const obj = await call(indicators, 'extended_market_hours');
  const period = await call(indicators, 'extended_market_period');

  assert.ok(obj && typeof obj === 'object');
  assert.strictEqual(typeof obj.period, 'string');
  // The object indicator and its scalar companion must agree on the period.
  assert.strictEqual(obj.period, period);
});

test('TimeIndicators - is_european_us_overlap scalar companion returns a boolean', async () => {
  const indicators = new TimeIndicators();
  const overlap = await call(indicators, 'is_european_us_overlap');

  assert.strictEqual(typeof overlap, 'boolean');
});

test('TimeIndicators - is_european_market_overlap object exposes a status string', async () => {
  const indicators = new TimeIndicators();
  const result = await call(indicators, 'is_european_market_overlap');

  assert.ok(result && typeof result === 'object');
  assert.ok(['active', 'inactive', 'closed'].includes(result.status));
});

test('TimeIndicators - all new indicators are registered with metadata', async () => {
  const indicators = new TimeIndicators();
  const names = [
    // object indicators
    'is_european_market_overlap',
    'multi_market_session_indicator',
    'extended_market_hours',
    // scalar companions
    'extended_market_period',
    'active_market_count',
    'is_european_us_overlap'
  ];
  for (const name of names) {
    assert.ok(indicators.getIndicators().has(name), `missing indicator: ${name}`);
    const meta = indicators.getMetadata(name);
    assert.ok(meta && typeof meta.type === 'string', `missing metadata.type for ${name}`);
    assert.strictEqual(meta.category, 'time');
  }

  // Scalar companions must declare scalar types so the rule engine can compare them.
  assert.strictEqual(indicators.getMetadata('extended_market_period').type, 'string');
  assert.strictEqual(indicators.getMetadata('active_market_count').type, 'number');
  assert.strictEqual(indicators.getMetadata('is_european_us_overlap').type, 'boolean');
});
