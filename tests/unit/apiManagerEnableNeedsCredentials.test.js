/**
 * A plugin disabled at load for missing credentials stays disabled when something asks to enable
 * it. The saved plugin states re-enabled groq, here, ipstack and spoonacular a second after every
 * boot, and "three quick dinner ideas" was routed to spoonacular with no API key (2026-10-20).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APIManager } from '../../src/api/core/apiManager.js';

function managerWith(missing) {
  const m = Object.create(APIManager.prototype);
  m.apis = new Map([['keyless', { enabled: false, instance: { missingRequiredCredentials: async () => missing } }]]);
  m.emit = () => {};
  return m;
}

test('enablePlugin refuses while a required credential is missing', async () => {
  const m = managerWith(['apiKey']);
  const r = await m.enablePlugin('keyless');
  assert.equal(r.success, false);
  assert.match(r.message, /needs credentials first \(apiKey\)/);
  assert.equal(m.apis.get('keyless').enabled, false);
  assert.equal(m.apis.get('keyless').disabledReason, 'missing_credentials');
});

test('enablePlugin enables a plugin that has its credentials', async () => {
  const m = managerWith([]);
  const r = await m.enablePlugin('keyless');
  assert.equal(r.success, true);
  assert.equal(m.apis.get('keyless').enabled, true);
});
