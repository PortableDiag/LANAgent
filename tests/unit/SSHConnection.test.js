import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test the model method in isolation — instantiate via the mongoose
// schema directly without saving, to avoid the DB dependency. This
// mirrors the technique mongoose docs recommend for testing instance
// methods.
import { SSHConnection } from '../../src/models/SSHConnection.js';

function fixtureConn() {
  // Real-shaped doc — sessionLogs is the only field the analytics
  // method reads.
  return new SSHConnection({
    connectionId: 'test-123',
    name: 'Test',
    host: 'localhost',
    port: 22,
    username: 'tester',
    sessionLogs: [
      { startTime: new Date('2026-05-01T10:00:00Z'), endTime: new Date('2026-05-01T10:30:00Z'), duration: 1800, error: null },
      { startTime: new Date('2026-05-02T14:00:00Z'), endTime: new Date('2026-05-02T14:15:00Z'), duration: 900,  error: 'Connection timeout' },
      { startTime: new Date('2026-05-03T09:00:00Z'), endTime: new Date('2026-05-03T09:45:00Z'), duration: 2700, error: null },
      // Out-of-window — should be filtered out by date range
      { startTime: new Date('2026-04-30T08:00:00Z'), endTime: new Date('2026-04-30T08:20:00Z'), duration: 1200, error: null }
    ]
  });
}

test('generateFilteredSessionReport: counts sessions inside the window only', () => {
  const conn = fixtureConn();
  const r = conn.generateFilteredSessionReport(
    new Date('2026-05-01T00:00:00Z'),
    new Date('2026-05-02T23:59:59Z'),
    'daily'
  );
  assert.equal(r.totalSessions, 2);
  assert.equal(r.completedSessions, 2);
  assert.equal(r.averageDuration, 1350);  // (1800 + 900) / 2
  assert.equal(r.errorRate, 50);          // 1 of 2 errored
});

test('generateFilteredSessionReport: counts errors and aggregates daily', () => {
  const conn = fixtureConn();
  const r = conn.generateFilteredSessionReport(
    new Date('2026-05-01T00:00:00Z'),
    new Date('2026-05-03T23:59:59Z'),
    'daily'
  );
  assert.equal(r.totalSessions, 3);
  // 1 of 3 errored ≈ 33.33%
  assert.ok(r.errorRate > 33 && r.errorRate < 34);
  // errorTrends is keyed by date string for the one errored session
  assert.equal(Object.values(r.errorTrends).reduce((a, b) => a + b, 0), 1);
});

test('generateFilteredSessionReport: handles empty window', () => {
  const conn = fixtureConn();
  const r = conn.generateFilteredSessionReport(
    new Date('2030-01-01'),
    new Date('2030-01-02'),
    'daily'
  );
  assert.equal(r.totalSessions, 0);
  assert.equal(r.completedSessions, 0);
  assert.equal(r.averageDuration, 0);
  assert.equal(r.errorRate, 0);
});

test('generateFilteredSessionReport: aggregationLevel weekly groups errors by week start', () => {
  const conn = fixtureConn();
  const r = conn.generateFilteredSessionReport(
    new Date('2026-05-01T00:00:00Z'),
    new Date('2026-05-03T23:59:59Z'),
    'weekly'
  );
  // Single error in the window — exactly 1 key
  assert.equal(Object.keys(r.errorTrends).length, 1);
});
