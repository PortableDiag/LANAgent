import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenUsage } from '../../src/models/TokenUsage.js';

async function withAggregate(result, fn) {
  const original = TokenUsage.aggregate;
  let pipeline;
  TokenUsage.aggregate = async p => { pipeline = p; return result; };
  try { return { out: await fn(), pipeline }; } finally { TokenUsage.aggregate = original; }
}

test('getUsageReport filters on a half-open createdAt range and groups by the requested dimensions', async () => {
  const rows = [{ _id: { provider: 'openai', day: new Date('2031-01-01') }, requests: 2 }];
  const { out, pipeline } = await withAggregate(rows, () => TokenUsage.getUsageReport({
    startDate: '2031-01-01', endDate: '2031-01-02', provider: 'openai', requestType: 'chat',
    groupBy: ['provider', 'day']
  }));

  assert.deepEqual(out, rows);
  const match = pipeline[0].$match;
  assert.equal(match.provider, 'openai');
  assert.equal(match.requestType, 'chat');
  assert.deepEqual(match.createdAt, { $gte: new Date('2031-01-01'), $lt: new Date('2031-01-02') });

  const group = pipeline[1].$group;
  assert.equal(group._id.provider, '$provider');
  assert.deepEqual(group._id.day, { $dateTrunc: { date: '$createdAt', unit: 'day', timezone: 'UTC' } });
  for (const field of ['requests', 'promptTokens', 'completionTokens', 'totalTokens', 'cost', 'averageResponseTime', 'errors']) {
    assert.ok(group[field], field);
  }
});

test('getUsageReport rejects unknown dimensions and invalid dates before querying', async () => {
  await assert.rejects(() => TokenUsage.getUsageReport({ groupBy: ['provider', 'color'] }), RangeError);
  await assert.rejects(() => TokenUsage.getUsageReport({ groupBy: [] }), TypeError);
  await assert.rejects(() => TokenUsage.getUsageReport({ startDate: 'not-a-date' }), TypeError);
});

test('getResponseTimePercentiles returns percentiles and count for a valid query', async () => {
  const resultDoc = { count: 3, p50: 100, p95: 200, p99: 300 };
  const { out, pipeline } = await withAggregate([resultDoc], () =>
    TokenUsage.getResponseTimePercentiles({
      provider: 'openai',
      model: 'gpt-4',
      startDate: '2031-01-01',
      endDate: '2031-01-02'
    })
  );

  assert.deepEqual(out, resultDoc);

  const match = pipeline[0].$match;
  assert.equal(match.provider, 'openai');
  assert.equal(match.model, 'gpt-4');
  assert.deepEqual(match.createdAt, { $gte: new Date('2031-01-01'), $lt: new Date('2031-01-02') });

  assert.equal(pipeline[1].$sort.responseTime, 1);
  assert.ok(pipeline[2].$group);
  assert.ok(pipeline[3].$project);
});

test('getResponseTimePercentiles throws if provider or model is missing', async () => {
  await assert.rejects(() => TokenUsage.getResponseTimePercentiles({}), Error);
  await assert.rejects(() => TokenUsage.getResponseTimePercentiles({ provider: 'x' }), Error);
  await assert.rejects(() => TokenUsage.getResponseTimePercentiles({ model: 'y' }), Error);
});

test('getResponseTimePercentiles throws for invalid dates', async () => {
  await assert.rejects(
    () => TokenUsage.getResponseTimePercentiles({ provider: 'a', model: 'b', startDate: 'not-a-date' }),
    TypeError
  );
  await assert.rejects(
    () => TokenUsage.getResponseTimePercentiles({ provider: 'a', model: 'b', endDate: 'bad' }),
    TypeError
  );
});

test('getResponseTimePercentiles caches results and only calls aggregate once', async () => {
  const provider = 'cachetest-' + Date.now();
  const model = 'model1';
  let aggregateCalls = 0;
  const originalAggregate = TokenUsage.aggregate;
  TokenUsage.aggregate = async () => {
    aggregateCalls++;
    return [{ count: 1, p50: 50, p95: 50, p99: 50 }];
  };
  try {
    const res1 = await TokenUsage.getResponseTimePercentiles({ provider, model });
    const res2 = await TokenUsage.getResponseTimePercentiles({ provider, model });
    assert.equal(aggregateCalls, 1, 'aggregate should be called only once due to caching');
    assert.deepEqual(res1, res2);
  } finally {
    TokenUsage.aggregate = originalAggregate;
  }
});

test('agentstats latency: real percentiles per model, and an honest empty answer', async () => {
  const { default: AgentStatsPlugin } = await import('../../src/api/plugins/agentStats.js');
  const orig = TokenUsage.aggregate;
  const seen = [];
  TokenUsage.aggregate = async (stages) => {
    seen.push(stages);
    if (stages[1].$group?._id?.provider) return [{ _id: { provider: 'openrouter', model: 'latency-test/m' }, n: 3 }];
    return [{ count: 3, p50: 100, p95: 300, p99: 300 }];
  };
  try {
    const plugin = new AgentStatsPlugin({});
    const r = await plugin.execute({ action: 'latency', days: 2 });
    assert.equal(r.success, true);
    assert.deepEqual(r.models, [{ provider: 'openrouter', model: 'latency-test/m', count: 3, p50: 100, p95: 300, p99: 300 }]);
    assert.match(r.result, /latency-test\/m: p50 100 ms, p95 300 ms/);
    assert.deepEqual(seen[1][0].$match.success, { $ne: false }, 'failed calls are not latency');

    TokenUsage.aggregate = async () => [];
    assert.match((await plugin.execute({ action: 'latency', model: 'none' })).result, /No AI calls/);
  } finally {
    TokenUsage.aggregate = orig;
  }
});
