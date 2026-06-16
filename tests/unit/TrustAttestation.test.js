import test from 'node:test';
import assert from 'node:assert/strict';

import TrustAttestation from '../../src/models/TrustAttestation.js';

// Stub aggregate so the REAL statics run and we can inspect the pipeline
// they build, plus the post-processing they perform on the results.
let calls = [];
let nextResult = [];
TrustAttestation.aggregate = (pipeline) => {
  calls.push(pipeline);
  return Promise.resolve(nextResult);
};

test('TrustAttestation analytics statics', async (t) => {
  await t.test('getTrustLevelDistribution builds a $group/$project pipeline and reshapes results', async () => {
    calls = [];
    nextResult = [
      { level: 'Full', count: 5 },
      { level: 'Marginal', count: 2 }
    ];

    const distribution = await TrustAttestation.getTrustLevelDistribution();

    assert.equal(calls.length, 1);
    const pipeline = calls[0];

    assert.equal(pipeline.length, 2);
    assert.ok(pipeline[0].$group, 'first stage is $group');
    assert.equal(pipeline[0].$group._id, '$level');
    assert.deepEqual(pipeline[0].$group.count, { $sum: 1 });
    assert.ok(pipeline[1].$project, 'second stage is $project');

    // Real static converts the array into an object keyed by level.
    assert.deepEqual(distribution, { Full: 5, Marginal: 2 });
  });

  await t.test('getTrustTrends builds an hourly time-bucketed pipeline with a $match window', async () => {
    calls = [];
    nextResult = [];

    const before = Date.now();
    const trends = await TrustAttestation.getTrustTrends(48);
    const after = Date.now();

    assert.equal(calls.length, 1);
    const pipeline = calls[0];

    assert.ok(pipeline[0].$match, 'first stage is $match');
    const since = pipeline[0].$match.createdAt.$gte;
    assert.ok(since instanceof Date, '$gte is a Date');

    // 48h window should land between (before - 48h) and (after - 48h).
    const windowMs = 48 * 60 * 60 * 1000;
    assert.ok(since.getTime() >= before - windowMs - 1000);
    assert.ok(since.getTime() <= after - windowMs + 1000);

    // Hourly bucketing via $dateToString in a $project stage.
    assert.ok(pipeline.some(s => s.$project && s.$project.hour && s.$project.hour.$dateToString),
      'has an hourly $dateToString projection');
    assert.deepEqual(trends, []);
  });

  await t.test('getTopTrustors builds a $group/$sort/$limit pipeline honoring the limit', async () => {
    calls = [];
    nextResult = [];

    await TrustAttestation.getTopTrustors(5);

    assert.equal(calls.length, 1);
    const pipeline = calls[0];

    assert.ok(pipeline[0].$group, 'first stage is $group');
    assert.deepEqual(pipeline[0].$group._id, {
      trustorNode: '$trustorNode',
      trustorName: '$trustorName'
    });

    const sortStage = pipeline.find(s => s.$sort);
    assert.ok(sortStage, 'has a $sort stage');
    assert.equal(sortStage.$sort.count, -1);

    const limitStage = pipeline.find(s => typeof s.$limit === 'number');
    assert.ok(limitStage, 'has a $limit stage');
    assert.equal(limitStage.$limit, 5);
  });
});
