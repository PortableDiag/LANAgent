import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { OperationLogger } from '../../src/services/operationLogger.js';

const seed = () => {
  const opLog = new OperationLogger();
  opLog.logOperation({
    type: 'plugin',
    action: 'execute',
    plugin: 'test-plugin',
    params: { command: 'start', apiKey: 'shhh-secret-value' },
    result: { success: true },
    status: 'success',
    userId: 'user123',
    interface: 'web'
  });
  opLog.logOperation({
    type: 'command',
    action: 'run',
    plugin: 'another-plugin',
    params: { command: 'stop' },
    result: { success: false },
    status: 'error',
    userId: 'user456',
    interface: 'ssh'
  });
  return opLog;
};

test('searchOperations filters by text query and additional filters', () => {
  const opLog = seed();

  const results = opLog.searchOperations('start', { status: 'success' });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'execute');
  assert.equal(results[0].plugin, 'test-plugin');

  // action and plugin are searched too, not just params
  assert.equal(opLog.searchOperations('another').length, 1);
  assert.equal(opLog.searchOperations('EXECUTE').length, 1, 'search is case-insensitive');
  assert.equal(opLog.searchOperations('nothing-matches-this').length, 0);

  // a query that conflicts with a filter yields nothing rather than everything
  assert.equal(opLog.searchOperations('start', { status: 'error' }).length, 0);
});

test('search cannot match on a redacted secret', () => {
  const opLog = seed();
  assert.equal(opLog.searchOperations('shhh-secret-value').length, 0);
  assert.equal(opLog.operations[0].params.apiKey, '***');
});

test('getHistory shares the filter path and accepts a query', () => {
  const opLog = seed();

  assert.equal(opLog.getHistory().length, 2);
  assert.equal(opLog.getHistory(1).length, 1);
  assert.equal(opLog.getHistory(50, { type: 'plugin' })[0].plugin, 'test-plugin');
  assert.equal(opLog.getHistory(50, { query: 'stop' }).length, 1);
  assert.equal(opLog.getHistory(50, { userId: 'user456' })[0].action, 'run');
});

test('time bounds accept ISO strings as well as Dates', () => {
  const opLog = seed();
  const before = new Date(Date.now() - 60000);
  const after = new Date(Date.now() + 60000);

  assert.equal(opLog.getOperationsByTimeRange(before, after).length, 2);
  // An ISO string bound used to coerce to NaN and match nothing
  assert.equal(opLog.getOperationsByTimeRange(before.toISOString(), after.toISOString()).length, 2);
  assert.equal(opLog.getHistory(50, { startTime: before.toISOString() }).length, 2);
  assert.equal(opLog.getOperationsByTimeRange(after, undefined).length, 0);
});

test('an omitted time bound leaves that side open', () => {
  const opLog = seed();
  const before = new Date(Date.now() - 60000);

  assert.equal(opLog.getOperationsByTimeRange(before).length, 2, 'no end bound means no upper limit');
  assert.equal(opLog.getOperationsByTimeRange(undefined, new Date(Date.now() + 60000)).length, 2);
  assert.equal(opLog.getOperationsByTimeRange().length, 2);
});

test('getSearchableHistory limits, and a limit of 0 means unlimited', () => {
  const opLog = seed();

  assert.equal(opLog.getSearchableHistory().length, 2);
  assert.equal(opLog.getSearchableHistory({ limit: 1 }).length, 1);
  assert.equal(opLog.getSearchableHistory({ limit: 0 }).length, 2);
  assert.equal(opLog.getSearchableHistory({ query: 'run' }).length, 1);
  assert.equal(opLog.getSearchableHistory({ filters: { status: 'error' } })[0].status, 'error');
});

test('results are newest first and the caller cannot mutate the store', () => {
  const opLog = seed();
  const results = opLog.searchOperations('');

  assert.equal(results[0].action, 'run', 'newest first');
  results.length = 0;
  assert.equal(opLog.operations.length, 2, 'the returned array is a copy');
});

test('getSummary returns correct counts and latency percentiles', () => {
  const opLog = new OperationLogger();

  // Add operations with known durations
  opLog.logOperation({
    type: 'plugin',
    action: 'execute',
    plugin: 'p1',
    params: {},
    result: {},
    status: 'success',
    userId: 'u1',
    interface: 'web',
    duration: 100
  });
  opLog.logOperation({
    type: 'plugin',
    action: 'execute',
    plugin: 'p1',
    params: {},
    result: {},
    status: 'success',
    userId: 'u1',
    interface: 'web',
    duration: 200
  });
  opLog.logOperation({
    type: 'command',
    action: 'run',
    plugin: 'p2',
    params: {},
    result: {},
    status: 'error',
    userId: 'u2',
    interface: 'ssh',
    duration: 300
  });
  opLog.logOperation({
    type: 'command',
    action: 'run',
    plugin: null,
    params: {},
    result: {},
    status: 'error',
    userId: 'u2',
    interface: 'ssh',
    duration: 400
  });

  const summary = opLog.getSummary();

  assert.equal(summary.total, 4);
  assert.deepStrictEqual(summary.byType, { plugin: 2, command: 2 });
  assert.deepStrictEqual(summary.byPlugin, { p1: 2, p2: 1 });
  assert.deepStrictEqual(summary.byStatus, { success: 2, error: 2 });
  assert.deepStrictEqual(summary.byInterface, { web: 2, ssh: 2 });
  assert.equal(summary.last24Hours, 4);
  assert.equal(summary.lastHour, 4);

  // Durations: [100, 200, 300, 400]
  // p50 index = ceil(0.5*4)-1 = 2-1 = 1 -> 200
  // p95 index = ceil(0.95*4)-1 = 4-1 = 3 -> 400
  // p99 index = ceil(0.99*4)-1 = 4-1 = 3 -> 400
  assert.equal(summary.latencyPercentiles.p50, 200);
  assert.equal(summary.latencyPercentiles.p95, 400);
  assert.equal(summary.latencyPercentiles.p99, 400);
});

test('getSummary latency percentiles are null when no durations', () => {
  const opLog = new OperationLogger();
  opLog.logOperation({
    type: 'plugin',
    action: 'execute',
    plugin: 'p1',
    params: {},
    result: {},
    status: 'success',
    userId: 'u1',
    interface: 'web'
    // no duration
  });

  const summary = opLog.getSummary();
  assert.equal(summary.total, 1);
  assert.equal(summary.latencyPercentiles.p50, null);
  assert.equal(summary.latencyPercentiles.p95, null);
  assert.equal(summary.latencyPercentiles.p99, null);
});

test('getSummary latency percentiles with single duration', () => {
  const opLog = new OperationLogger();
  opLog.logOperation({
    type: 'plugin',
    action: 'execute',
    plugin: 'p1',
    params: {},
    result: {},
    status: 'success',
    userId: 'u1',
    interface: 'web',
    duration: 42
  });

  const summary = opLog.getSummary();
  assert.equal(summary.latencyPercentiles.p50, 42);
  assert.equal(summary.latencyPercentiles.p95, 42);
  assert.equal(summary.latencyPercentiles.p99, 42);
});

test('a 0ms duration is kept, not collapsed to null', () => {
  const opLog = new OperationLogger();
  opLog.logOperation({ type: 'plugin', action: 'a', status: 'success', duration: 0 });
  opLog.logOperation({ type: 'plugin', action: 'b', status: 'success', duration: 'n/a' });
  assert.equal(opLog.operations.find(o => o.action === 'a').duration, 0);
  assert.equal(opLog.operations.find(o => o.action === 'b').duration, null);
  const summary = opLog.getSummary();
  assert.equal(summary.latencyPercentiles.p50, 0);
  assert.equal(summary.latencyPercentiles.p99, 0);
});
