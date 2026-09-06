/**
 * The two benchmark statics.
 *
 * These run against a real in-process MongoDB when one is reachable, because the
 * defect they pin lives in an aggregation pipeline and a stubbed `aggregate()`
 * cannot see it: the original computed the system conversion rate by filtering
 * to `status: 'paid'` and then averaging "is this paid?", which scores 1 for
 * every surviving row. That yields exactly 100% for any non-empty collection —
 * a constant shaped like a measurement, against which every real user reads as
 * underperforming.
 *
 * Set MONGO_TEST_URI to point at a scratch database. Without one the suite skips
 * rather than failing, so it stays runnable on a machine with no mongod.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import SkynetReferral from '../../src/models/SkynetReferral.js';

const URI = process.env.MONGO_TEST_URI;
let live = false;

before(async () => {
  if (!URI) return;
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 2000 });
    await SkynetReferral.deleteMany({});
    const row = (ref, rd, status, amt, src) => ({
      referrerFingerprint: ref, referredFingerprint: rd,
      serviceId: 'svc1', status, rewardAmount: amt, referralSource: src
    });
    // 10 referrals, 4 paid → the true system conversion rate is 40%.
    // Paid rewards 100 + 200 + 50 + 50 → average 100.
    // Referrers with at least one paid referral: alice, bob, carol → 3.
    await SkynetReferral.insertMany([
      row('alice', 'r1', 'paid', 100, 'web'),
      row('alice', 'r2', 'paid', 200, 'web'),
      row('alice', 'r3', 'pending', 0, 'web'),
      row('bob', 'r4', 'paid', 50, 'p2p'),
      row('bob', 'r5', 'failed', 0, 'p2p'),
      row('bob', 'r6', 'pending', 0, 'p2p'),
      row('carol', 'r7', 'paid', 50, 'web'),
      row('carol', 'r8', 'pending', 0, 'web'),
      row('dave', 'r9', 'pending', 0, 'p2p'),
      row('dave', 'r10', 'failed', 0, 'p2p')
    ]);
    live = true;
  } catch {
    live = false;
  }
});

after(async () => {
  if (live) {
    await SkynetReferral.deleteMany({});
    await mongoose.disconnect();
  }
});

test('the system conversion rate is measured over all referrals, not just paid ones', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const { systemAverages } = await SkynetReferral.getReferralBenchmark('alice');

  assert.equal(systemAverages.conversionRate, 40,
    '4 paid of 10 referrals. A value of 100 means the pipeline filtered to paid rows first');
});

test('the average reward stays scoped to paid referrals', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const { systemAverages } = await SkynetReferral.getReferralBenchmark('alice');

  assert.equal(systemAverages.averageReward, 100,
    'unpaid rows carry a zero reward and must not drag the paid average down');
});

test('active referrers counts only those with a paid referral', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const { systemAverages } = await SkynetReferral.getReferralBenchmark('alice');

  assert.equal(systemAverages.totalActiveReferrers, 3,
    'dave has referrals but none paid, so he is not an active referrer');
});

test('the comparison is against the real average, so it can be positive', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const bench = await SkynetReferral.getReferralBenchmark('alice');

  // alice: 2 paid of 3 = 66.67%, against a system 40%.
  assert.ok(bench.comparison.conversionRatePerformance > 0,
    'an above-average referrer must not read as underperforming');
  assert.equal(Math.round(bench.comparison.conversionRatePerformance * 100) / 100, 26.67);
});

test('the tier distribution counts referrers per tier', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const { systemAverages } = await SkynetReferral.getReferralBenchmark('alice');

  // All three paid referrers sit in the lowest tier at 1-2 paid referrals.
  assert.deepEqual(systemAverages.tierDistribution, { 1: 3 });
});

test('getBenchmarkStats reports platform totals', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const { overview } = await SkynetReferral.getBenchmarkStats();

  assert.equal(overview.totalReferrals, 10);
  assert.equal(overview.paidReferrals, 4);
  assert.equal(overview.conversionRate, 40, 'must agree with the benchmark figure');
  assert.equal(overview.totalRewards, 400);
  assert.equal(overview.referredUsers, 10);
});

test('getBenchmarkStats breaks down sources and tiers', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  const stats = await SkynetReferral.getBenchmarkStats();

  assert.deepEqual(stats.sourceDistribution, { web: 5, p2p: 5 });
  assert.deepEqual(stats.tierDistribution, { Bronze: 3 });
});

test('an empty collection produces zeros rather than throwing', async (t) => {
  if (!live) return t.skip('no MONGO_TEST_URI');

  await SkynetReferral.deleteMany({});
  try {
    const { overview } = await SkynetReferral.getBenchmarkStats();
    assert.equal(overview.totalReferrals, 0);
    assert.equal(overview.conversionRate, 0,
      'no referrals is a 0% rate, not a division error');
  } finally {
    live = false; // the fixtures are gone; later tests would be meaningless
  }
});
