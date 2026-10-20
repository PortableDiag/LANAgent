import test from 'node:test';
import assert from 'node:assert/strict';
import SystemLogsPlugin from '../../src/api/plugins/systemLogs.js';
import { excludedPlugins } from '../../src/services/reasoning/toolCatalog.js';

function chain(rows, calls) {
  const q = { sort: (s) => { calls.sort = s; return q; }, limit: (n) => { calls.limit = n; return q; }, lean: async () => rows };
  return q;
}
function plugin(rows = [], aggregates = []) {
  const calls = {};
  const p = new SystemLogsPlugin({});
  let i = 0;
  p.model = {
    find: (q) => { calls.find = q; return chain(rows, calls); },
    findById: (id) => ({ lean: async () => rows.find(r => String(r._id) === id) || null }),
    aggregate: async () => aggregates[i++] || []
  };
  return { p, calls };
}
const row = (over = {}) => ({ _id: '6a1b2c3d4e5f6a7b8c9d0e1f', createdAt: new Date('2026-10-03T15:00:00Z'), level: 'error', category: 'network', message: 'fetch failed', source: { service: 'crypto' }, ...over });

test('recent filters by level, category, service and period, newest first', async () => {
  const { p, calls } = plugin([row()]);
  const r = await p.execute({ action: 'recent', level: 'errors', category: 'network', service: 'cry', hours: 6, limit: 500 });
  assert.equal(r.success, true);
  assert.equal(calls.find.level, 'error');
  assert.equal(calls.find.category, 'network');
  assert.ok(calls.find['source.service'].test('crypto'));
  assert.ok(Date.now() - calls.find.createdAt.$gte.getTime() <= 6 * 3600_000 + 1000);
  assert.deepEqual(calls.sort, { createdAt: -1 });
  assert.equal(calls.limit, 100, 'limit is capped');
  assert.match(r.result, /ERROR \[crypto\] fetch failed \(id 6a1b2c3d4e5f6a7b8c9d0e1f\)/);
});

test('recent rejects an unknown level or category instead of returning nothing', async () => {
  const { p } = plugin();
  assert.match((await p.execute({ action: 'recent', level: 'loud' })).error, /level must be one of/);
  assert.match((await p.execute({ action: 'recent', category: 'weather' })).error, /category must be one of/);
  const ok = await p.execute({ action: 'recent', level: 'warnings' });
  assert.equal(ok.success, true);
});

test('a service filter is matched literally, not as a pattern', async () => {
  const { p, calls } = plugin();
  await p.execute({ action: 'recent', service: '.*' });
  assert.equal(calls.find['source.service'].test('crypto'), false);
});

test('search uses the text index for words and a literal match for symbols', async () => {
  const { p, calls } = plugin([row()]);
  await p.execute({ action: 'search', query: 'timeout openrouter' });
  assert.deepEqual(calls.find.$text, { $search: 'timeout openrouter' });
  await p.execute({ action: 'search', query: '0xbb4CdB9C.(x)' });
  assert.equal(calls.find.$text, undefined);
  assert.ok(calls.find.$or[0].message.test('swap 0xbb4cdb9c.(x) failed'));
  assert.equal(calls.find.$or[0].message.test('0xbb4cdb9cZ(x)'), false);
  assert.match((await p.execute({ action: 'search' })).error, /query is required/);
});

test('summary counts by level, category and service and folds flood counts in', async () => {
  const { p } = plugin([], [
    [{ _id: 'warn', n: 40 }, { _id: 'error', n: 2 }],
    [{ _id: 'network', n: 30 }, { _id: 'system', n: 12 }],
    [{ _id: 'crypto', n: 35 }, { _id: null, n: 7 }],
    [{ _id: { level: 'warn', m: 'Network scan failed for bsc' }, n: 120, last: new Date() }]
  ]);
  const r = await p.execute({ action: 'summary', hours: 24 });
  assert.equal(r.total, 42);
  assert.deepEqual(r.byLevel, { warn: 40, error: 2 });
  assert.equal(r.byService.unknown, 7);
  assert.match(r.result, /42 stored warnings and errors in the last 24 h/);
  assert.match(r.result, /120× WARN Network scan failed for bsc/);
});

test('summary says plainly when nothing is stored', async () => {
  const { p } = plugin([], [[], [], [], []]);
  const r = await p.execute({ action: 'summary', hours: 2 });
  assert.equal(r.total, 0);
  assert.equal(r.result, 'No warnings or errors stored in the last 2 h.');
});

test('entry shows details and the stack; a bad id is refused', async () => {
  const { p } = plugin([row({ details: { pair: 'WBNB/BUSD' }, error: { stack: 'Error: fetch failed\n    at swap (x.js:1)' } })]);
  const r = await p.execute({ action: 'entry', id: '6a1b2c3d4e5f6a7b8c9d0e1f' });
  assert.match(r.result, /details: \{"pair":"WBNB\/BUSD"\}/);
  assert.match(r.result, /at swap/);
  assert.match((await p.execute({ action: 'entry', id: 'abc' })).error, /24-character/);
  assert.equal((await p.execute({ action: 'entry', id: 'ffffffffffffffffffffffff' })).success, false);
});

const hourKey = (msAgo) => { const d = new Date(Date.now() - msAgo); d.setUTCMinutes(0, 0, 0); return d.toISOString().replace('.000Z', 'Z'); };

test('trend: hourly buckets, zero-filled across the window, bars scaled to the peak', async () => {
  const { p } = plugin([], [[{ _id: hourKey(2 * 3600_000), count: 2 }, { _id: hourKey(3600_000), count: 5 }]]);
  const r = await p.execute({ action: 'trend', hours: 6 });
  assert.equal(r.success, true);
  assert.equal(r.interval, 'hour');
  assert.ok(r.series.length >= 6 && r.series.length <= 8, `zero-filled: ${r.series.length}`);
  assert.equal(r.series.filter(s => s.count === 0).length, r.series.length - 2);
  assert.ok(r.series.every(s => s.timestamp instanceof Date && !isNaN(s.timestamp)));
  assert.match(r.result, /^7 warnings and errors in the last 6 h, per hour \(UTC\):/);
  assert.match(r.result, /   5 █{10}$/m);
  assert.match(r.result, /   2 █{4}░{6}$/m);
  assert.match(r.result, /   0 ░{10}$/m);
});

test('trend: day interval groups by UTC day and uses a day label', async () => {
  const pipelines = [];
  const p = new SystemLogsPlugin({});
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const key = today.toISOString().replace('.000Z', 'Z');
  p.model = { aggregate: async (pl) => { pipelines.push(pl); return [{ _id: key, count: 3 }]; } };
  const r = await p.execute({ action: 'trend', interval: 'daily', hours: 168 });
  assert.equal(r.interval, 'day');
  assert.equal(pipelines[0][1].$group._id.$dateToString.format, '%Y-%m-%dT00:00:00Z');
  assert.ok(r.result.includes(`${key.slice(0, 10)}    3 ██████████`));
});

test('trend: no rows gives an empty series and a plain message', async () => {
  const { p } = plugin([], [[]]);
  const r = await p.execute({ action: 'trend', level: 'error', category: 'network' });
  assert.equal(r.success, true);
  assert.deepEqual(r.series, []);
  assert.match(r.result, /No error network stored in the last 48 hours/);
});

test('trend: filters reach the $match, counts include suppressed repeats, no $dateTrunc', async () => {
  const pipelines = [];
  const p = new SystemLogsPlugin({});
  p.model = { aggregate: async (pl) => { pipelines.push(pl); return []; } };
  await p.execute({ action: 'trend', level: 'warn', category: 'system', service: 'crypto', hours: 12 });
  const [m, g, so] = pipelines[0];
  assert.equal(m.$match.level, 'warn');
  assert.equal(m.$match.category, 'system');
  assert.ok(m.$match['source.service'] instanceof RegExp);
  assert.ok(Date.now() - m.$match.createdAt.$gte.getTime() <= 12 * 3600_000 + 1000);
  assert.equal(g.$group._id.$dateToString.format, '%Y-%m-%dT%H:00:00Z');
  assert.deepEqual(g.$group.count.$sum.$add[1], { $ifNull: ['$details.suppressed', 0] });
  assert.deepEqual(so.$sort, { _id: 1 });
  assert.equal(JSON.stringify(pipelines[0]).includes('$dateTrunc'), false);
});

test('trend: a long hourly window lists only non-empty buckets', async () => {
  const { p } = plugin([], [[{ _id: hourKey(100 * 3600_000), count: 1 }, { _id: hourKey(3600_000), count: 4 }]]);
  const r = await p.execute({ action: 'trend', hours: 200 });
  assert.equal(r.series.length, 2);
  assert.match(r.result, /empty buckets omitted/);
});

test('other agents cannot reach the logs; the owner can', () => {
  assert.equal(excludedPlugins({ trellis: { peer: 'Orbit' } }).has('systemLogs'), true);
  assert.equal(excludedPlugins(null).has('systemLogs'), false);
});
