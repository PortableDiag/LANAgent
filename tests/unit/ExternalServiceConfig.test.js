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
