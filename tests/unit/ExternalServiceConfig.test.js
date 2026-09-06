import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import ExternalServiceConfig from '../../src/models/ExternalServiceConfig.js';

test('validateImportPayload accepts a valid payload and returns { valid, errors }', () => {
  const result = ExternalServiceConfig.validateImportPayload({
    serviceId: 'svc-1', name: 'Test Service', price: '10'
  });
  assert.equal(result.valid, true);
  assert.deepStrictEqual(result.errors, []);
});

test('validateImportPayload rejects a payload missing required fields', () => {
  const result = ExternalServiceConfig.validateImportPayload({ name: 'No id or price' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('importConfiguration creates a new config when none exists', async () => {
  const origFindOne = ExternalServiceConfig.findOne;
  const origSave = ExternalServiceConfig.prototype.save;
  ExternalServiceConfig.findOne = async () => null;          // no existing service
  ExternalServiceConfig.prototype.save = async function () { return this; };
  try {
    const res = await ExternalServiceConfig.importConfiguration({
      serviceId: 'svc-1', name: 'Test Service', price: '10'
    });
    assert.equal(res.success, true);
    assert.equal(res.action, 'created');
    assert.equal(res.serviceId, 'svc-1');
  } finally {
    ExternalServiceConfig.findOne = origFindOne;
    ExternalServiceConfig.prototype.save = origSave;
  }
});

test('validateImportPayload accepts dependencies as array of strings', () => {
  const result = ExternalServiceConfig.validateImportPayload({
    serviceId: 'svc-1',
    name: 'Test Service',
    price: '10',
    dependencies: ['dep-svc-1', 'dep-svc-2']
  });
  assert.equal(result.valid, true);
  assert.deepStrictEqual(result.errors, []);
});

test('validateDependencies flags missing and disabled services', async () => {
  const origFind = ExternalServiceConfig.find;
  ExternalServiceConfig.find = () => ({
    select: async () => [
      { serviceId: 'dep-ok', enabled: true },
      { serviceId: 'dep-off', enabled: false }
    ]
  });
  try {
    const result = await ExternalServiceConfig.validateDependencies(['dep-ok', 'dep-off', 'dep-gone']);
    assert.equal(result.valid, false);
    assert.deepStrictEqual(result.details.missing, ['dep-gone']);
    assert.deepStrictEqual(result.details.disabled, ['dep-off']);

    assert.deepStrictEqual(await ExternalServiceConfig.validateDependencies([]), { valid: true, errors: [] });
  } finally {
    ExternalServiceConfig.find = origFind;
  }
});

test('checkDependencies walks chains, allows diamonds, rejects cycles', async () => {
  const services = {
    a: { serviceId: 'a', enabled: true, dependencies: ['b', 'c'] },
    b: { serviceId: 'b', enabled: true, dependencies: ['d'] },
    c: { serviceId: 'c', enabled: true, dependencies: ['d'] },
    d: { serviceId: 'd', enabled: true, dependencies: [] },
    loop1: { serviceId: 'loop1', enabled: true, dependencies: ['loop2'] },
    loop2: { serviceId: 'loop2', enabled: true, dependencies: ['loop1'] },
    broken: { serviceId: 'broken', enabled: true, dependencies: ['nonexistent'] }
  };
  const origFindOne = ExternalServiceConfig.findOne;
  ExternalServiceConfig.findOne = async ({ serviceId }) => services[serviceId] || null;
  try {
    // diamond (a→b→d, a→c→d) is valid and d is verified only once
    const diamond = await ExternalServiceConfig.checkDependencies('a');
    assert.equal(diamond.valid, true);
    assert.deepStrictEqual(diamond.chain, ['a', 'b', 'd', 'c']);

    const cycle = await ExternalServiceConfig.checkDependencies('loop1');
    assert.equal(cycle.valid, false);
    assert.match(cycle.error, /Circular dependency/);

    const missing = await ExternalServiceConfig.checkDependencies('broken');
    assert.equal(missing.valid, false);
    assert.match(missing.error, /not found/);
  } finally {
    ExternalServiceConfig.findOne = origFindOne;
  }
});

test('validateImportPayload accepts fallbackChain as array of strings', () => {
  const result = ExternalServiceConfig.validateImportPayload({
    serviceId: 'svc-1',
    name: 'Test Service',
    price: '10',
    fallbackChain: ['fallback-svc-1', 'fallback-svc-2']
  });
  assert.equal(result.valid, true);
  assert.deepStrictEqual(result.errors, []);
});

// --- fallback chain -------------------------------------------------------
//
// The shipped test covered the import-schema half only. These exercise the
// selection logic, which is where the ordering rules actually live.

const withServices = (byId) => {
  const origFindOne = ExternalServiceConfig.findOne;
  const origFind = ExternalServiceConfig.find;
  ExternalServiceConfig.findOne = async ({ serviceId }) => byId[serviceId] || null;
  ExternalServiceConfig.find = ({ serviceId: { $in: ids }, enabled }) => ({
    select: () => Promise.resolve(
      ids.map(id => byId[id]).filter(s => s && (enabled === undefined || s.enabled === enabled))
    )
  });
  return () => {
    ExternalServiceConfig.findOne = origFindOne;
    ExternalServiceConfig.find = origFind;
  };
};

test('getFallbackChain returns the configured chain', async (t) => {
  t.after(withServices({ a: { serviceId: 'a', fallbackChain: ['b', 'c'] } }));

  assert.deepStrictEqual(await ExternalServiceConfig.getFallbackChain('a'), ['b', 'c']);
});

test('getFallbackChain returns an empty chain when none is set', async (t) => {
  t.after(withServices({ a: { serviceId: 'a' } }));

  assert.deepStrictEqual(await ExternalServiceConfig.getFallbackChain('a'), []);
});

test('getFallbackChain rejects an unknown service', async (t) => {
  t.after(withServices({}));

  await assert.rejects(() => ExternalServiceConfig.getFallbackChain('nope'), /not found/);
});

test('selectFallbackService returns null when there is no chain', async (t) => {
  t.after(withServices({ a: { serviceId: 'a', fallbackChain: [] } }));

  assert.equal(await ExternalServiceConfig.selectFallbackService('a'), null);
});

test('selectFallbackService skips disabled fallbacks', async (t) => {
  t.after(withServices({
    a: { serviceId: 'a', fallbackChain: ['off', 'on'] },
    off: { serviceId: 'off', enabled: false, totalRequests: 0 },
    on: { serviceId: 'on', enabled: true, totalRequests: 500 }
  }));

  assert.equal(await ExternalServiceConfig.selectFallbackService('a'), 'on',
    'a disabled service must not be chosen even when it is first and least loaded');
});

test('selectFallbackService returns null when every fallback is disabled', async (t) => {
  t.after(withServices({
    a: { serviceId: 'a', fallbackChain: ['off1', 'off2'] },
    off1: { serviceId: 'off1', enabled: false, totalRequests: 0 },
    off2: { serviceId: 'off2', enabled: false, totalRequests: 0 }
  }));

  assert.equal(await ExternalServiceConfig.selectFallbackService('a'), null);
});

test('selectFallbackService prefers the least-loaded fallback', async (t) => {
  t.after(withServices({
    a: { serviceId: 'a', fallbackChain: ['busy', 'quiet'] },
    busy: { serviceId: 'busy', enabled: true, totalRequests: 900 },
    quiet: { serviceId: 'quiet', enabled: true, totalRequests: 3 }
  }));

  // Chain order is a preference list, but load wins — otherwise the first entry
  // absorbs every failover and the chain is just a single spare.
  assert.equal(await ExternalServiceConfig.selectFallbackService('a'), 'quiet');
});

test('selectFallbackService breaks a load tie with the longest-idle service', async (t) => {
  const older = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-09-01T00:00:00Z');
  t.after(withServices({
    a: { serviceId: 'a', fallbackChain: ['recent', 'stale'] },
    recent: { serviceId: 'recent', enabled: true, totalRequests: 10, lastUsed: newer },
    stale: { serviceId: 'stale', enabled: true, totalRequests: 10, lastUsed: older }
  }));

  assert.equal(await ExternalServiceConfig.selectFallbackService('a'), 'stale');
});

test('selectFallbackService ignores chain entries that do not exist', async (t) => {
  t.after(withServices({
    a: { serviceId: 'a', fallbackChain: ['ghost', 'real'] },
    real: { serviceId: 'real', enabled: true, totalRequests: 42 }
  }));

  assert.equal(await ExternalServiceConfig.selectFallbackService('a'), 'real',
    'a chain naming a deleted service must degrade, not throw');
});
