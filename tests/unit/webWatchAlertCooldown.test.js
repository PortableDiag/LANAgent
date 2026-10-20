import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePrice } from '../../src/services/webtools/webWatchService.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const base = { url: 'https://shop.example.com/item/1', name: 'Item', lastPrice: 100, changePct: 5, targetPrice: null, alertedTarget: false };

test('a percentage move inside the cooldown is suppressed and does not move lastAlertedAt', () => {
  const watch = { ...base, alertCooldownMin: 60, lastAlertedAt: new Date(T0 - 30 * 60000) };
  const r = evaluatePrice(watch, { price: 90 }, { now: T0 });
  assert.equal(r.alert, null);
  assert.equal(r.suppressed, true);
  assert.equal(r.update.lastAlertedAt, undefined);
  assert.equal(r.update.lastPrice, 90);
});

test('a percentage move after the cooldown alerts and stamps lastAlertedAt', () => {
  const watch = { ...base, alertCooldownMin: 60, lastAlertedAt: new Date(T0 - 61 * 60000) };
  const r = evaluatePrice(watch, { price: 90 }, { now: T0 });
  assert.match(r.alert, /drop 10\.0%/);
  assert.equal(r.suppressed, false);
  assert.equal(r.update.lastAlertedAt.getTime(), T0);
});

test('no cooldown configured (default 0) behaves as before', () => {
  const r = evaluatePrice({ ...base, lastAlertedAt: new Date(T0 - 1000) }, { price: 110 }, { now: T0 });
  assert.match(r.alert, /rise 10\.0%/);
});

test('a target-price alert is never suppressed by the cooldown', () => {
  const watch = { ...base, changePct: 0, targetPrice: 95, alertCooldownMin: 600, lastAlertedAt: new Date(T0 - 60000) };
  const r = evaluatePrice(watch, { price: 94 }, { now: T0 });
  assert.match(r.alert, /target reached/);
  assert.equal(r.update.alertedTarget, true);
});
