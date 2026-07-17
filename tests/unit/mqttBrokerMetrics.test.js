import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { summarizeBrokerMetrics } from '../../src/models/MqttBroker.js';

test('summarizeBrokerMetrics aggregates history into dashboard values', () => {
  const t = (m) => new Date(Date.UTC(2026, 0, 1, 0, m));
  const s = summarizeBrokerMetrics({
    connectionHistory: [
      { timestamp: t(0), count: 2 },
      { timestamp: t(1), count: 5 },
      { timestamp: t(2), count: 3 }
    ],
    messageRateHistory: [
      { timestamp: t(0), received: 10, sent: 4 },
      { timestamp: t(1), received: 20, sent: 6 },
      { timestamp: t(2), received: 0, sent: 2 }
    ],
    errorHistory: [
      { timestamp: t(1), type: 'client_error', count: 2 },
      { timestamp: t(2), type: 'client_error', count: 1 },
      { timestamp: t(2), type: 'ECONNRESET', count: 1 }
    ]
  });

  assert.equal(s.sampleCount, 3);
  assert.equal(s.peakConnections, 5);
  assert.equal(s.currentConnections, 3);
  assert.deepEqual(s.messageRate, { received: 10, sent: 4 });
  assert.deepEqual(s.errorDistribution, { client_error: 3, ECONNRESET: 1 });
  assert.equal(s.totalErrors, 4);
  assert.equal(s.windowStart.getTime(), t(0).getTime());
  assert.equal(s.windowEnd.getTime(), t(2).getTime());
});

test('summarizeBrokerMetrics handles empty and missing history', () => {
  for (const input of [{}, undefined, { connectionHistory: [], messageRateHistory: [], errorHistory: [] }]) {
    const s = summarizeBrokerMetrics(input);
    assert.equal(s.sampleCount, 0);
    assert.equal(s.peakConnections, 0);
    assert.equal(s.currentConnections, 0);
    assert.deepEqual(s.messageRate, { received: 0, sent: 0 });
    assert.deepEqual(s.errorDistribution, {});
    assert.equal(s.totalErrors, 0);
    assert.equal(s.windowStart, null);
  }
});

test('summarizeBrokerMetrics tolerates entries with missing numeric fields', () => {
  const s = summarizeBrokerMetrics({
    connectionHistory: [{ timestamp: new Date() }],
    messageRateHistory: [{ timestamp: new Date() }],
    errorHistory: [{ timestamp: new Date(), type: 'x' }]
  });
  assert.equal(s.peakConnections, 0);
  assert.deepEqual(s.messageRate, { received: 0, sent: 0 });
  assert.deepEqual(s.errorDistribution, { x: 0 });
});
