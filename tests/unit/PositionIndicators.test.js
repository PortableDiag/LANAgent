import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indicatorProvider } from '../../src/services/crypto/indicators/index.js';

test('indicatorProvider.listIndicators exposes metadata for every family', () => {
  const indicators = indicatorProvider.listIndicators();
  assert.ok(Array.isArray(indicators));
  assert.ok(indicators.length > 0);

  for (const meta of indicators) {
    assert.equal(typeof meta.name, 'string');
    assert.equal(typeof meta.type, 'string');
    assert.equal(typeof meta.description, 'string');
    assert.equal(typeof meta.category, 'string');
  }

  const names = new Set(indicators.map(m => m.name));
  // position family is registered through the provider
  for (const expected of ['in_position', 'position_size', 'unrealized_pnl', 'total_pnl']) {
    assert.ok(names.has(expected), `missing indicator ${expected}`);
  }

  const inPosition = indicators.find(m => m.name === 'in_position');
  assert.equal(inPosition.type, 'boolean');
});

test('getIndicatorsByCategory filters to a single category', () => {
  const position = indicatorProvider.getIndicatorsByCategory('position');
  assert.ok(position.length > 0);
  assert.ok(position.every(m => m.category === 'position'));
  // and is a strict subset of the full list
  assert.ok(position.length < indicatorProvider.listIndicators().length);
});
