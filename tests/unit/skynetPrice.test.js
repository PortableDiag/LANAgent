import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSkynetPriceHistory,
  _bucketByHour,
  _seedPriceHistoryForTest
} from '../../src/services/crypto/skynetPrice.js';

const HOUR_MS = 60 * 60 * 1000;

test('_bucketByHour groups by absolute hour key and uses bucket-start timestamps', () => {
  // Two captures in hour bucket A, one in the next hour bucket B.
  const base = 1_700_000_000_000; // arbitrary epoch ms
  const hourA = Math.floor(base / HOUR_MS) * HOUR_MS;
  const hourB = hourA + HOUR_MS;

  const data = [
    { ts: hourA + 60_000, skynetUsd: 100, bnbUsd: 300, skyReserve: 1000, bnbReserve: 3000 },
    { ts: hourA + 120_000, skynetUsd: 110, bnbUsd: 320, skyReserve: 900, bnbReserve: 3200 },
    { ts: hourB + 60_000, skynetUsd: 200, bnbUsd: 400, skyReserve: 800, bnbReserve: 3400 }
  ];

  const buckets = _bucketByHour(data);

  assert.equal(buckets.length, 2, 'two distinct hour buckets');
  // Bucket timestamps must be the bucket START, not the first raw ts.
  assert.equal(buckets[0].timestamp, hourA);
  assert.equal(buckets[1].timestamp, hourB);
  // First bucket averages the two captures.
  assert.equal(buckets[0].skynetUsd, 105);
  assert.equal(buckets[0].bnbUsd, 310);
  assert.equal(buckets[0].skyReserve, 950);
  assert.equal(buckets[0].bnbReserve, 3100);
  // Second bucket is the single capture.
  assert.equal(buckets[1].skynetUsd, 200);
});

test('_bucketByHour does NOT collide same clock-hour across different days', () => {
  // Same UTC hour-of-day (the old bug), but 24h apart -> must be two buckets.
  const day1 = Math.floor(1_700_000_000_000 / HOUR_MS) * HOUR_MS;
  const day2 = day1 + 24 * HOUR_MS;

  const data = [
    { ts: day1 + 1000, skynetUsd: 10, bnbUsd: 100, skyReserve: 1, bnbReserve: 1 },
    { ts: day2 + 1000, skynetUsd: 20, bnbUsd: 200, skyReserve: 2, bnbReserve: 2 }
  ];

  const buckets = _bucketByHour(data);
  assert.equal(buckets.length, 2, 'same hour-of-day on different days must not merge');
  assert.equal(buckets[0].timestamp, day1);
  assert.equal(buckets[1].timestamp, day2);
});

test('getSkynetPriceHistory returns hourly-bucketed entries from the cache', () => {
  const now = Date.now();
  const hourA = Math.floor((now - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const hourB = hourA + HOUR_MS;

  _seedPriceHistoryForTest([
    { ts: hourA + 1000, skynetUsd: 100, bnbUsd: 300, skyReserve: 1000, bnbReserve: 3000 },
    { ts: hourA + 2000, skynetUsd: 102, bnbUsd: 304, skyReserve: 980, bnbReserve: 3040 },
    { ts: hourB + 1000, skynetUsd: 110, bnbUsd: 320, skyReserve: 900, bnbReserve: 3200 }
  ]);

  const result = getSkynetPriceHistory({ hours: 24, interval: 'hour' });

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
  assert.ok(result.every(p => typeof p.timestamp === 'number'));
  assert.equal(result[0].timestamp, hourA);
  assert.equal(result[0].skynetUsd, 101); // (100 + 102) / 2
  assert.equal(result[1].timestamp, hourB);
  assert.equal(result[1].skynetUsd, 110);
});

test('getSkynetPriceHistory interval=minute returns raw, unaggregated captures', () => {
  const now = Date.now();
  _seedPriceHistoryForTest([
    { ts: now - 1000, skynetUsd: 1, bnbUsd: 2, skyReserve: 3, bnbReserve: 4 },
    { ts: now - 500, skynetUsd: 5, bnbUsd: 6, skyReserve: 7, bnbReserve: 8 }
  ]);

  const result = getSkynetPriceHistory({ hours: 24, interval: 'minute' });
  assert.equal(result.length, 2);
  assert.equal(result[0].skynetUsd, 1);
  assert.equal(result[1].skynetUsd, 5);
});

test('getSkynetPriceHistory honors the hours lookback cutoff', () => {
  const now = Date.now();
  _seedPriceHistoryForTest([
    { ts: now - 5 * HOUR_MS, skynetUsd: 1, bnbUsd: 1, skyReserve: 1, bnbReserve: 1 }, // outside 1h window
    { ts: now - 30 * 60 * 1000, skynetUsd: 2, bnbUsd: 2, skyReserve: 2, bnbReserve: 2 } // inside 1h window
  ]);

  const result = getSkynetPriceHistory({ hours: 1, interval: 'minute' });
  assert.equal(result.length, 1);
  assert.equal(result[0].skynetUsd, 2);
});
