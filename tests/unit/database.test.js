import test from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForDatabase,
  DatabaseCancellationError,
  DatabaseUnavailableError
} from '../../src/utils/database.js';

test('waitForDatabase rejects immediately when cancellation has already occurred', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => waitForDatabase({ signal: controller.signal }),
    error => {
      assert.ok(error instanceof DatabaseCancellationError);
      assert.equal(error.name, 'DatabaseCancellationError');
      assert.equal(error.code, 'DATABASE_CONNECTION_CANCELLED');
      return true;
    }
  );
});

test('waitForDatabase reports unavailable when reconnecting is disabled', async () => {
  await assert.rejects(
    () => waitForDatabase({ allowReconnect: false }),
    error => {
      assert.ok(error instanceof DatabaseUnavailableError);
      assert.equal(error.name, 'DatabaseUnavailableError');
      assert.equal(error.code, 'DATABASE_CONNECTION_UNAVAILABLE');
      return true;
    }
  );
});

test('waitForDatabase validates timeoutMs before waiting', async () => {
  await assert.rejects(
    () => waitForDatabase({ timeoutMs: -1, allowReconnect: false }),
    error => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'timeoutMs must be a finite, non-negative number.');
      return true;
    }
  );

  await assert.rejects(
    () => waitForDatabase({ timeoutMs: Infinity, allowReconnect: false }),
    error => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'timeoutMs must be a finite, non-negative number.');
      return true;
    }
  );
});

test('concurrent connectDatabase callers share one attempt', async () => {
  const { default: mongoose } = await import('mongoose');
  const { connectDatabase } = await import('../../src/utils/database.js');
  const original = mongoose.connect;
  let calls = 0;
  let release;
  mongoose.connect = () => { calls++; return new Promise(r => { release = r; }); };
  try {
    const a = connectDatabase();
    const b = connectDatabase();
    await new Promise(r => setImmediate(r));
    release();
    const [ca, cb] = await Promise.all([a, b]);
    assert.equal(calls, 1);
    assert.equal(ca, mongoose.connection);
    assert.equal(cb, mongoose.connection);
  } finally {
    mongoose.connect = original;
    mongoose.connection.removeAllListeners();
  }
});

test('permanent connect errors are recognised; server-selection is not permanent', async () => {
  const { isPermanentConnectError } = await import('../../src/utils/database.js');
  assert.equal(isPermanentConnectError(Object.assign(new Error('bad uri'), { name: 'MongoParseError' })), true);
  assert.equal(isPermanentConnectError(Object.assign(new Error('auth'), { name: 'MongoServerError', code: 18 })), true);
  assert.equal(isPermanentConnectError(Object.assign(new Error('down'), { name: 'MongooseServerSelectionError' })), false);
  assert.equal(isPermanentConnectError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), false);
  assert.equal(isPermanentConnectError(undefined), false);
});

test('connect backoff grows with every failure and caps at 30s', async () => {
  const { connectBackoffDelay } = await import('../../src/utils/database.js');
  assert.equal(connectBackoffDelay(0), 1000);
  assert.equal(connectBackoffDelay(3), 8000);
  assert.equal(connectBackoffDelay(5), 30000);
  assert.equal(connectBackoffDelay(50), 30000);
});

test('dbTuning reads MONGO_* overrides and falls back on missing, non-numeric or out-of-range values', async () => {
  const { dbTuning } = await import('../../src/utils/database.js');
  assert.deepEqual(dbTuning({}), {
    MAX_RECONNECT_ATTEMPTS: 10, RECONNECT_BASE_INTERVAL: 1000, RECONNECT_MAX_INTERVAL: 30000,
    CIRCUIT_BREAKER_THRESHOLD: 5, CIRCUIT_BREAKER_COOLDOWN: 30000
  });
  const t = dbTuning({ MONGO_MAX_RECONNECT_ATTEMPTS: '0', MONGO_RECONNECT_BASE_INTERVAL_MS: '250', MONGO_CIRCUIT_BREAKER_THRESHOLD: 'abc', MONGO_CIRCUIT_BREAKER_COOLDOWN_MS: '-5', MONGO_RECONNECT_MAX_INTERVAL_MS: '1.5' });
  assert.equal(t.MAX_RECONNECT_ATTEMPTS, 0, 'a legitimate 0 is kept');
  assert.equal(t.RECONNECT_BASE_INTERVAL, 250);
  assert.equal(t.CIRCUIT_BREAKER_THRESHOLD, 5);
  assert.equal(t.CIRCUIT_BREAKER_COOLDOWN, 30000);
  assert.equal(t.RECONNECT_MAX_INTERVAL, 30000);
});
