import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import ArbSignal from '../../src/models/ArbSignal.js';

/**
 * Build the bucket rows getSignalBuckets would return, so the correlation
 * maths can be exercised without a live Mongo connection.
 */
function buckets(rows) {
  return rows.map(([symbol, bucket, avgSpread, avgProfit, count]) => ({
    symbol, bucket, avgSpread, avgProfit, count: count ?? 1
  }));
}

test('findCorrelatedSignals scores perfectly co-moving spreads as +1', async () => {
  const stub = mock.method(ArbSignal, 'getSignalBuckets', async () => buckets([
    ['BTC', 1, 0.01, 10], ['BTC', 2, 0.02, 20], ['BTC', 3, 0.03, 30],
    ['ETH', 1, 0.02, 15], ['ETH', 2, 0.04, 25], ['ETH', 3, 0.06, 35]
  ]));

  try {
    const result = await ArbSignal.findCorrelatedSignals('BTC', 'bsc', 60, { noCache: true });
    assert.equal(stub.mock.callCount(), 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].symbol, 'ETH');
    assert.equal(result[0].coOccurrences, 3);
    assert.equal(result[0].correlationCoefficient, 1);
    assert.equal(result[0].coOccurrenceRate, 1);
  } finally {
    stub.mock.restore();
  }
});

test('findCorrelatedSignals scores inversely moving spreads as -1', async () => {
  const stub = mock.method(ArbSignal, 'getSignalBuckets', async () => buckets([
    ['BTC', 1, 0.01, 10], ['BTC', 2, 0.02, 20], ['BTC', 3, 0.03, 30],
    ['ETH', 1, 0.06, 15], ['ETH', 2, 0.04, 25], ['ETH', 3, 0.02, 35]
  ]));

  try {
    const result = await ArbSignal.findCorrelatedSignals('BTC', 'bsc', 60, { noCache: true });
    assert.equal(result[0].correlationCoefficient, -1);
  } finally {
    stub.mock.restore();
  }
});

test('findCorrelatedSignals returns null correlation for a constant series', async () => {
  const stub = mock.method(ArbSignal, 'getSignalBuckets', async () => buckets([
    ['BTC', 1, 0.01, 10], ['BTC', 2, 0.02, 20], ['BTC', 3, 0.03, 30],
    ['ETH', 1, 0.05, 15], ['ETH', 2, 0.05, 25], ['ETH', 3, 0.05, 35]
  ]));

  try {
    const result = await ArbSignal.findCorrelatedSignals('BTC', 'bsc', 60, { noCache: true });
    assert.equal(result.length, 1);
    assert.equal(result[0].correlationCoefficient, null);
  } finally {
    stub.mock.restore();
  }
});

test('findCorrelatedSignals drops symbols below the minimum overlap', async () => {
  const stub = mock.method(ArbSignal, 'getSignalBuckets', async () => buckets([
    ['BTC', 1, 0.01, 10], ['BTC', 2, 0.02, 20], ['BTC', 3, 0.03, 30],
    ['ETH', 1, 0.02, 15], ['ETH', 2, 0.04, 25], ['ETH', 3, 0.06, 35],
    ['SOL', 1, 0.09, 5], ['SOL', 9, 0.09, 5]
  ]));

  try {
    const result = await ArbSignal.findCorrelatedSignals('BTC', 'bsc', 60, { noCache: true });
    assert.deepEqual(result.map(r => r.symbol), ['ETH']);

    const relaxed = await ArbSignal.findCorrelatedSignals('BTC', 'bsc', 60, { noCache: true, minOverlap: 1 });
    assert.deepEqual(relaxed.map(r => r.symbol).sort(), ['ETH', 'SOL']);
  } finally {
    stub.mock.restore();
  }
});

test('findCorrelatedSignals sorts strongest positive correlation first, nulls last', async () => {
  const stub = mock.method(ArbSignal, 'getSignalBuckets', async () => buckets([
    ['BTC', 1, 0.01, 10], ['BTC', 2, 0.02, 20], ['BTC', 3, 0.03, 30],
    ['ETH', 1, 0.02, 15], ['ETH', 2, 0.04, 25], ['ETH', 3, 0.06, 35],  // +1
    ['SOL', 1, 0.06, 15], ['SOL', 2, 0.04, 25], ['SOL', 3, 0.02, 35],  // -1
    ['ADA', 1, 0.05, 15], ['ADA', 2, 0.05, 25], ['ADA', 3, 0.05, 35]   // null
  ]));

  try {
    const result = await ArbSignal.findCorrelatedSignals('BTC', 'bsc', 60, { noCache: true });
    assert.deepEqual(result.map(r => r.symbol), ['ETH', 'SOL', 'ADA']);
  } finally {
    stub.mock.restore();
  }
});

test('findCorrelatedSignals returns empty when the base symbol has no signals', async () => {
  const stub = mock.method(ArbSignal, 'getSignalBuckets', async () => buckets([
    ['ETH', 1, 0.02, 15], ['ETH', 2, 0.04, 25]
  ]));

  try {
    assert.deepEqual(await ArbSignal.findCorrelatedSignals('BTC', 'bsc', 60, { noCache: true }), []);
    assert.deepEqual(await ArbSignal.findCorrelatedSignals('', 'bsc', 60, { noCache: true }), []);
  } finally {
    stub.mock.restore();
  }
});

test('findCorrelatedSignals builds the expected match and bucket width', async () => {
  let captured = null;
  const stub = mock.method(ArbSignal, 'getSignalBuckets', async (match, bucketMs) => {
    captured = { match, bucketMs };
    return [];
  });

  try {
    await ArbSignal.findCorrelatedSignals('BTC', 'bsc', 15, { noCache: true, lookbackHours: 6 });
    assert.equal(captured.bucketMs, 15 * 60 * 1000);
    assert.equal(captured.match.network, 'bsc');
    assert.equal(captured.match.expired, false);
    const ageMs = Date.now() - captured.match.createdAt.$gte.getTime();
    assert.ok(Math.abs(ageMs - 6 * 60 * 60 * 1000) < 5000, 'lookback window should be ~6h');

    await ArbSignal.findCorrelatedSignals('BTC', undefined, 60, { noCache: true, includeExpired: true });
    assert.equal(captured.match.network, undefined);
    assert.equal(captured.match.expired, undefined);
  } finally {
    stub.mock.restore();
  }
});

test('findCorrelatedSignals caches results per parameter set', async () => {
  const stub = mock.method(ArbSignal, 'getSignalBuckets', async () => buckets([
    ['CACHEME', 1, 0.01, 10], ['CACHEME', 2, 0.02, 20], ['CACHEME', 3, 0.03, 30],
    ['ETH', 1, 0.02, 15], ['ETH', 2, 0.04, 25], ['ETH', 3, 0.06, 35]
  ]));

  try {
    const first = await ArbSignal.findCorrelatedSignals('CACHEME', 'bsc', 60);
    const second = await ArbSignal.findCorrelatedSignals('CACHEME', 'bsc', 60);
    assert.equal(stub.mock.callCount(), 1, 'second identical call should be served from cache');
    assert.deepEqual(first, second);

    await ArbSignal.findCorrelatedSignals('CACHEME', 'ethereum', 60);
    assert.equal(stub.mock.callCount(), 2, 'a different network is a different cache key');
  } finally {
    stub.mock.restore();
  }
});
