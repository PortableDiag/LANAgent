// Graceful shutdown (src/utils/errorHandlers.js): SIGTERM/SIGINT run the registered cleanup
// newest-first, bounded by a deadline, once, then exit. index.js registers agent.stop here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerShutdownHandler, setupGlobalErrorHandlers, setSeverityMap, captureError, isSentryEnabled } from '../../src/utils/errorHandlers.js';
import { logger } from '../../src/utils/logger.js';

test('registerShutdownHandler validates input; unregister removes only its own handler', () => {
  assert.throws(() => registerShutdownHandler('', () => {}), TypeError);
  assert.throws(() => registerShutdownHandler('x', null), TypeError);
  const off = registerShutdownHandler('tmp', () => {});
  off();
  assert.doesNotThrow(() => off());
});

test('SIGTERM runs handlers newest-first, bounded, once, then exits 0', async () => {
  const calls = [];
  registerShutdownHandler('db', async () => { await new Promise(r => setTimeout(r, 5)); calls.push('db'); });
  registerShutdownHandler('stuck', () => new Promise(() => {}));   // never settles
  registerShutdownHandler('agent', () => { calls.push('agent'); });
  const stale = registerShutdownHandler('replaced', () => calls.push('old'));
  registerShutdownHandler('replaced', () => calls.push('new'));
  stale();   // an old unregister must not remove the replacement

  const originalExit = process.exit;
  const exits = [];
  process.exit = (code) => { exits.push(code); };
  process.env.SHUTDOWN_TIMEOUT_MS = '100';
  const before = new Set(process.listeners('SIGTERM'));
  try {
    setupGlobalErrorHandlers();
    setupGlobalErrorHandlers();   // idempotent: one listener, not two
    const added = process.listeners('SIGTERM').filter(l => !before.has(l));
    assert.equal(added.length, 1);
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    for (let i = 0; i < 400 && exits.length === 0; i++) await new Promise(r => setTimeout(r, 25));
    assert.deepEqual(calls, ['new', 'agent']);   // 'stuck' consumed the budget; 'db' skipped
    assert.deepEqual(exits, [0]);
  } finally {
    process.exit = originalExit;
    for (const l of process.listeners('SIGTERM')) if (!before.has(l)) process.removeListener('SIGTERM', l);
  }
});

// ---------------------------------------------------------------------------
// Severity mapping and captureError
// ---------------------------------------------------------------------------

// Stub ONLY the methods winston really has — stubbing a fake `logger.warning`
// would hide a TypeError in production.
function stubLoggerMethods() {
  const originals = {};
  const calls = [];
  for (const method of ['error', 'warn', 'info', 'debug']) {
    originals[method] = logger[method];
    logger[method] = (...args) => { calls.push({ method, args }); };
  }
  return { calls, restore: () => Object.assign(logger, originals) };
}

test('winston has no warning/fatal method (why captureError maps levels)', () => {
  assert.equal(typeof logger.warning, 'undefined');
  assert.equal(typeof logger.fatal, 'undefined');
});

test('setSeverityMap rejects non-objects and non-Sentry levels', () => {
  assert.throws(() => setSeverityMap(null), TypeError);
  assert.throws(() => setSeverityMap('string'), TypeError);
  assert.throws(() => setSeverityMap(123), TypeError);
  assert.throws(() => setSeverityMap([]), TypeError);
  assert.throws(() => setSeverityMap({ X: 'catastrophic' }), /not a Sentry level/);
});

test('captureError with explicit Sentry levels logs through the matching winston method', () => {
  const { calls, restore } = stubLoggerMethods();
  try {
    captureError(new Error('boom'), {}, 'warning');
    captureError(new Error('boom'), {}, 'fatal');
    captureError(new Error('boom'), {}, 'warn');
    captureError(new Error('boom'), {}, 'bogus');
    assert.deepEqual(calls.map(c => c.method), ['warn', 'error', 'warn', 'error']);
    assert.ok(calls[0].args[0].includes('Captured warning'));
    assert.ok(calls[1].args[0].includes('Captured fatal'));
    assert.ok(calls[3].args[0].includes('Captured error'), 'unknown level falls back to error');
  } finally {
    restore();
  }
});

test('captureError classifies by error.name, then error.severity, else error', () => {
  setSeverityMap({ ValidationError: 'warning', low: 'info' }, { replace: true });
  const { calls, restore } = stubLoggerMethods();
  try {
    const v = new Error('invalid'); v.name = 'ValidationError';
    const l = new Error('minor'); l.severity = 'low';
    const u = new Error('generic'); u.name = 'UnknownError';
    captureError(v, {});
    captureError(l, {});
    captureError(u, {});
    assert.deepEqual(calls.map(c => c.method), ['warn', 'info', 'error']);
    assert.ok(calls[1].args[0].includes('Captured info'));
  } finally {
    restore();
    setSeverityMap({}, { replace: true });
  }
});

test('explicit level overrides the map; inherited keys are not matched', () => {
  setSeverityMap({ ValidationError: 'warning' }, { replace: true });
  const { calls, restore } = stubLoggerMethods();
  try {
    const v = new Error('invalid'); v.name = 'ValidationError';
    captureError(v, {}, 'debug');
    const p = new Error('x'); p.name = 'constructor';
    captureError(p, {});
    assert.deepEqual(calls.map(c => c.method), ['debug', 'error']);
  } finally {
    restore();
    setSeverityMap({}, { replace: true });
  }
});

test('setSeverityMap merges by default and replace clears', () => {
  setSeverityMap({ ValidationError: 'warning' }, { replace: true });
  setSeverityMap({ TimeoutError: 'info' });
  const { calls, restore } = stubLoggerMethods();
  try {
    const a = new Error('a'); a.name = 'ValidationError';
    const b = new Error('b'); b.name = 'TimeoutError';
    captureError(a, {}); captureError(b, {});
    setSeverityMap({}, { replace: true });
    captureError(a, {});
    assert.deepEqual(calls.map(c => c.method), ['warn', 'info', 'error']);
  } finally {
    restore();
  }
});

test('captureError handles string errors and never throws without Sentry', () => {
  const { calls, restore } = stubLoggerMethods();
  try {
    assert.doesNotThrow(() => captureError('something went wrong', {}, 'error'));
    assert.doesNotThrow(() => captureError(null, {}));
    assert.equal(calls.length, 2);
    assert.equal(isSentryEnabled(), false);
  } finally {
    restore();
  }
});
