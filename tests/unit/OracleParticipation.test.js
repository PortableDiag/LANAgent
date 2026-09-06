import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import OracleParticipation from '../../src/models/OracleParticipation.js';

test('cleanupExpired removes expired documents older than retention period', async (t) => {
  // Restore afterwards: mock.method patches the shared model, and an unrestored
  // stub leaks into every later test in this file.
  t.after(() => mock.restoreAll());
  const mockDeleteMany = mock.method(OracleParticipation, 'deleteMany', () => Promise.resolve({ deletedCount: 5 }));

  const before = Date.now();
  const result = await OracleParticipation.cleanupExpired(30);
  const after = Date.now();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.deletedCount, 5);
  assert.strictEqual(result.retentionDays, 30);

  const query = mockDeleteMany.mock.calls[0].arguments[0];
  assert.strictEqual(query.status, 'expired');

  // The cutoff is computed inside the call — assert it lands 30 days back
  // within the call window instead of comparing Dates for exact equality
  // ±2h tolerance: setDate() arithmetic shifts by an hour across DST boundaries
  const cutoff = query.updatedAt.$lt.getTime();
  const DAY = 24 * 60 * 60 * 1000;
  const TOL = 2 * 60 * 60 * 1000;
  assert.ok(cutoff >= before - 30 * DAY - TOL && cutoff <= after - 30 * DAY + TOL,
    `cutoff ${new Date(cutoff).toISOString()} not ~30 days before the call`);
});

test('getStatistics returns combined oracle participation statistics', async (t) => {
  t.after(() => mock.restoreAll());
  const mockGetWinRate = mock.method(OracleParticipation, 'getWinRate', () => 
    Promise.resolve([{ total: 10, wins: 7, winRate: 0.7 }])
  );
  const mockGetEarningsStats = mock.method(OracleParticipation, 'getEarningsStats', () => 
    Promise.resolve([
      { _id: 'info', count: 5, totalEarned: 100.50 },
      { _id: 'judge', count: 3, totalEarned: 75.25 }
    ])
  );
  const mockGetParticipationTrends = mock.method(OracleParticipation, 'getParticipationTrends', () => 
    Promise.resolve([
      { _id: { period: '2023-01-01', role: 'info' }, count: 3, totalReward: 60.00 },
      { _id: { period: '2023-01-01', role: 'judge' }, count: 1, totalReward: 25.00 }
    ])
  );

  const result = await OracleParticipation.getStatistics({ period: 'day', since: new Date('2023-01-01') });

  assert.ok(result.winRate);
  assert.strictEqual(result.winRate.total, 10);
  assert.strictEqual(result.winRate.wins, 7);
  assert.strictEqual(result.winRate.winRate, 0.7);

  assert.ok(result.earnings);
  assert.strictEqual(result.earnings.info.count, 5);
  assert.strictEqual(result.earnings.info.totalEarned, 100.50);
  assert.strictEqual(result.earnings.judge.count, 3);
  assert.strictEqual(result.earnings.judge.totalEarned, 75.25);

  assert.ok(result.trends);
  assert.ok(result.trends['2023-01-01']);
  assert.strictEqual(result.trends['2023-01-01'].info.count, 3);
  assert.strictEqual(result.trends['2023-01-01'].info.totalReward, 60.00);
  assert.strictEqual(result.trends['2023-01-01'].judge.count, 1);
  assert.strictEqual(result.trends['2023-01-01'].judge.totalReward, 25.00);

  assert.strictEqual(mockGetWinRate.mock.callCount(), 1);
  assert.strictEqual(mockGetEarningsStats.mock.callCount(), 1);
  assert.strictEqual(mockGetParticipationTrends.mock.callCount(), 1);
});

/**
 * getPerformanceBenchmark.
 *
 * The generated test for this asserted a shape the function never returns
 * (`result.user.winRate.winRate`, `result.user.earnings.info.totalEarned` — the
 * function returns `user.winRate` as a number and has no `earnings` key), and
 * its stub dispatched on a condition that could never be reached, since the
 * "user earnings" branch was a strict subset of the "user win rate" branch
 * above it. It failed outright.
 *
 * These run against a real database, because the two defects repaired here were
 * denominator and unit mismatches between aggregations — a stubbed `aggregate`
 * returning invented rows cannot expose either.
 *
 * Set MONGO_TEST_URI to a scratch database; without one they skip.
 */
import mongoose from 'mongoose';

const URI = process.env.MONGO_TEST_URI;
let live = false;

const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  if (!URI) return;
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 2000 });
    await OracleParticipation.deleteMany({});
    const now = Date.now();
    const row = (requestId, requester, status, tracked, reward, ageDays) => ({
      requestId, role: 'info', requester, status,
      revenueTracked: tracked, rewardEarned: String(reward),
      createdAt: new Date(now - ageDays * DAY)
    });
    // alice: 4 participations spanning 10 days → 0.4/day; 3 won of 4 → 75%;
    //        2 revenue-tracked totalling 100 → average 50.
    // bob:   2 participations spanning 20 days → 0.1/day; 1 won of 2 → 50%;
    //        1 revenue-tracked totalling 20 → average 20.
    // Network: 4 wins of 6 decided → 66.7%; 3 tracked totalling 120 → average 40;
    //          mean per-participant rate = (0.4 + 0.1) / 2 = 0.25/day.
    await OracleParticipation.insertMany([
      row(1, 'alice', 'won', true, 60, 10),
      row(2, 'alice', 'won', true, 40, 5),
      row(3, 'alice', 'won', false, 0, 3),
      row(4, 'alice', 'lost', false, 0, 1),
      row(5, 'bob', 'won', true, 20, 20),
      row(6, 'bob', 'lost', false, 0, 2)
    ]);
    live = true;
  } catch {
    live = false;
  }
});

after(async () => {
  if (live) {
    await OracleParticipation.deleteMany({});
    await mongoose.disconnect();
  }
});

test('the user win rate is scoped to that user', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const b = await OracleParticipation.getPerformanceBenchmark('alice');
  assert.strictEqual(Number(b.user.winRate.toFixed(3)), 0.75, '3 won of 4 decided');
  assert.strictEqual(Number(b.network.winRate.toFixed(3)), 0.667, '4 won of 6 network-wide');
});

test('average reward uses the same denominator on both sides', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const b = await OracleParticipation.getPerformanceBenchmark('alice');

  // Both count revenue-tracked participations only. Dividing network earnings by
  // ALL participations would give 120/6 = 20 and overstate the gap threefold.
  assert.strictEqual(b.user.averageReward, 50, '(60+40) over 2 tracked');
  assert.strictEqual(b.network.averageReward, 40, '(60+40+20) over 3 tracked, not over 6');
  assert.strictEqual(b.comparison.rewardDifference, 10);
});

test('participation frequency is a per-day rate on both sides', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const b = await OracleParticipation.getPerformanceBenchmark('alice');

  assert.strictEqual(Number(b.user.participationFrequency.toFixed(3)), 0.4, '4 over 10 days');
  assert.strictEqual(Number(b.network.averageParticipationFrequency.toFixed(3)), 0.25,
    'the mean of each participant\'s own per-day rate, not participations per participant');
});

test('the frequency comparison has the right sign for an active user', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const b = await OracleParticipation.getPerformanceBenchmark('alice');

  // alice is the more active participant (0.4/day vs bob's 0.1/day). Subtracting
  // a per-participant count (6/2 = 3) from a per-day rate reported her at -2.6.
  assert.ok(b.comparison.frequencyDifference > 0,
    'the most active participant must not read as below average');
  assert.strictEqual(Number(b.comparison.frequencyDifference.toFixed(3)), 0.15);
});

test('an unknown address returns zeros rather than throwing', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const b = await OracleParticipation.getPerformanceBenchmark('nobody');

  assert.strictEqual(b.user.winRate, 0);
  assert.strictEqual(b.user.participationCount, 0);
  assert.strictEqual(b.user.participationFrequency, 0, 'no first participation means no rate');
  assert.strictEqual(b.user.averageReward, 0);
});
