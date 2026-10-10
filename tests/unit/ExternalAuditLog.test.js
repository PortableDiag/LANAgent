import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ExternalAuditLog from '../../src/models/ExternalAuditLog.js';

beforeEach(() => mock.restoreAll());

test('getTopIPAddresses builds a windowed, null-safe, limited pipeline', async () => {
  const agg = mock.method(ExternalAuditLog, 'aggregate', (pipeline) => ({
    exec: async () => {
      const match = pipeline[0].$match;
      assert.deepEqual(match.ip, { $ne: null });
      assert.ok(match.timestamp.$gte instanceof Date);
      // ~7 day window
      const windowMs = Date.now() - match.timestamp.$gte.getTime();
      assert.ok(Math.abs(windowMs - 7 * 24 * 3600 * 1000) < 5000);

      assert.deepEqual(pipeline.find(s => s.$sort), { $sort: { requestCount: -1 } });
      assert.deepEqual(pipeline.find(s => s.$limit !== undefined), { $limit: 5 });

      return [
        { _id: '203.0.113.7', requestCount: 42, avgDuration: 120, successCount: 40, failureCount: 2, lastActivity: new Date() },
        { _id: '198.51.100.2', requestCount: 11, avgDuration: 300, successCount: 9, failureCount: 2, lastActivity: new Date() }
      ];
    }
  }));

  const result = await ExternalAuditLog.getTopIPAddresses({ days: 7, limit: 5 });

  assert.equal(agg.mock.callCount(), 1);
  assert.equal(result[0]._id, '203.0.113.7');
  assert.equal(result[0].requestCount, 42);
});

test('getTopIPAddresses works with no arguments (defaults)', async () => {
  mock.method(ExternalAuditLog, 'aggregate', (pipeline) => ({
    exec: async () => {
      assert.deepEqual(pipeline.find(s => s.$limit !== undefined), { $limit: 10 });
      return [];
    }
  }));

  const result = await ExternalAuditLog.getTopIPAddresses();
  assert.deepEqual(result, []);
});

test('queryLogs applies composable filters and cursor pagination with a bounded limit', async () => {
  const cursorTimestamp = new Date('2025-01-15T12:00:00.000Z');
  const cursorId = '507f1f77bcf86cd799439011';
  const cursor = Buffer.from(JSON.stringify({
    timestamp: cursorTimestamp.toISOString(),
    id: cursorId
  }), 'utf8').toString('base64url');

  const firstLog = {
    _id: '507f1f77bcf86cd799439012',
    timestamp: new Date('2025-01-16T12:00:00.000Z'),
    method: 'POST',
    path: '/payments',
    requestBody: '{"amount":100}',
    responseBody: '{"ok":true}'
  };
  const secondLog = {
    _id: '507f1f77bcf86cd799439013',
    timestamp: new Date('2025-01-16T13:00:00.000Z'),
    method: 'POST',
    path: '/payments',
    requestBody: '{"amount":200}',
    responseBody: '{"ok":true}'
  };
  const extraLog = {
    _id: '507f1f77bcf86cd799439014',
    timestamp: new Date('2025-01-16T14:00:00.000Z'),
    method: 'POST',
    path: '/payments'
  };

  let capturedQuery;
  let requestedLimit;
  let requestedSort;

  mock.method(ExternalAuditLog, 'find', (query) => {
    capturedQuery = query;

    const chain = {
      sort(value) {
        requestedSort = value;
        return chain;
      },
      limit(value) {
        requestedLimit = value;
        return chain;
      },
      select() {
        return chain;
      },
      lean() {
        return chain;
      },
      exec: async () => [firstLog, secondLog, extraLog]
    };

    return chain;
  });

  const result = await ExternalAuditLog.queryLogs({
    startDate: '2025-01-01T00:00:00.000Z',
    endDate: '2025-01-31T23:59:59.999Z',
    agentId: 'agent-7',
    ip: '203.0.113.10',
    method: 'POST',
    path: '/payments',
    statusCode: 201,
    success: true,
    paymentTx: 'tx-123',
    cursor,
    limit: 2,
    includeBodies: true
  });

  assert.deepEqual(capturedQuery.timestamp, {
    $gte: new Date('2025-01-01T00:00:00.000Z'),
    $lte: new Date('2025-01-31T23:59:59.999Z')
  });
  assert.equal(capturedQuery.agentId, 'agent-7');
  assert.equal(capturedQuery.ip, '203.0.113.10');
  assert.equal(capturedQuery.method, 'POST');
  assert.equal(capturedQuery.path, '/payments');
  assert.equal(capturedQuery.statusCode, 201);
  assert.equal(capturedQuery.success, true);
  assert.equal(capturedQuery.paymentTx, 'tx-123');
  assert.deepEqual(capturedQuery.$or[0], { timestamp: { $lt: cursorTimestamp } });
  assert.deepEqual(capturedQuery.$or[1].timestamp, cursorTimestamp);
  // The cursor id must reach Mongo as an ObjectId: a string never compares $lt an ObjectId.
  assert.ok(capturedQuery.$or[1]._id.$lt instanceof mongoose.Types.ObjectId);
  assert.equal(String(capturedQuery.$or[1]._id.$lt), cursorId);

  assert.deepEqual(requestedSort, { timestamp: -1, _id: -1 });
  assert.equal(requestedLimit, 3);
  assert.equal(result.logs.length, 2);
  assert.equal(result.logs[0], firstLog);
  assert.equal(result.logs[1], secondLog);
  assert.ok(typeof result.nextCursor === 'string');

  const decodedNextCursor = JSON.parse(
    Buffer.from(result.nextCursor, 'base64url').toString('utf8')
  );
  assert.equal(decodedNextCursor.timestamp, secondLog.timestamp.toISOString());
  assert.equal(decodedNextCursor.id, secondLog._id);
});

test('queryLogs rejects a tampered cursor and excludes bodies by default', async () => {
  let selected;
  mock.method(ExternalAuditLog, 'find', () => {
    const chain = { sort: () => chain, limit: () => chain, select: (v) => { selected = v; return chain; }, lean: () => chain, exec: async () => [] };
    return chain;
  });
  await assert.rejects(ExternalAuditLog.queryLogs({ cursor: 'not-a-cursor' }), /cursor is invalid/);
  const r = await ExternalAuditLog.queryLogs({});
  assert.equal(selected, '-requestBody -responseBody');
  assert.equal(r.nextCursor, null);
});

test('getDurationPercentiles uses $percentile and maps values to requested percentiles', async () => {
  const agg = mock.method(ExternalAuditLog, 'aggregate', (pipeline) => ({
    exec: async () => {
      const group = pipeline[1].$group;
      assert.deepEqual(group.values.$percentile.p, [0.5, 0.95]);
      assert.ok(pipeline[0].$match.timestamp.$gte instanceof Date);
      assert.equal(pipeline[0].$match.agentId, 'a1');
      return [{ _id: null, count: 4, values: [100, 900] }];
    }
  }));
  const r = await ExternalAuditLog.getDurationPercentiles({
    startDate: '2026-10-01', endDate: '2026-10-08', agentId: 'a1', percentiles: [50, 95]
  });
  assert.equal(agg.mock.callCount(), 1);
  assert.deepEqual(r, { count: 4, percentiles: { 50: 100, 95: 900 } });
});

test('getDurationPercentiles falls back to nearest-rank JS when $percentile is rejected', async () => {
  let call = 0;
  mock.method(ExternalAuditLog, 'aggregate', () => ({
    exec: async () => {
      call++;
      if (call === 1) throw new Error("Unrecognized expression '$percentile'");
      return [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(duration => ({ duration }));
    }
  }));
  const r = await ExternalAuditLog.getDurationPercentiles({ startDate: new Date(0), endDate: new Date() });
  assert.deepEqual(r, { count: 10, percentiles: { 50: 50, 95: 100, 99: 100 } });
});

test('getDurationPercentiles reports null, not 0, for an empty window', async () => {
  mock.method(ExternalAuditLog, 'aggregate', () => ({ exec: async () => [] }));
  const r = await ExternalAuditLog.getDurationPercentiles({ startDate: new Date(0), endDate: new Date() });
  assert.deepEqual(r, { count: 0, percentiles: { 50: null, 95: null, 99: null } });
});

test('getDurationPercentiles validates its inputs', async () => {
  await assert.rejects(ExternalAuditLog.getDurationPercentiles({}), TypeError);
  await assert.rejects(ExternalAuditLog.getDurationPercentiles({ startDate: 'x', endDate: 'y' }), TypeError);
  await assert.rejects(ExternalAuditLog.getDurationPercentiles({ startDate: new Date(0), endDate: new Date(), percentiles: [0] }), TypeError);
});
