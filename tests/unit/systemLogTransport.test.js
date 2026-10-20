import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemLogTransport, categorize } from '../../src/utils/systemLogTransport.js';

function sink(opts = {}) {
  const stored = [];
  let now = opts.start ?? 1_000_000;
  const t = new SystemLogTransport({
    flushMs: 0,
    batchSize: 1000,
    isConnected: opts.isConnected || (() => true),
    now: () => now,
    getModel: async () => ({ insertMany: opts.insertMany || (async (docs) => { stored.push(...docs); }) }),
    ...opts.extra
  });
  return { t, stored, advance: (ms) => { now += ms; } };
}
const log = (t, info) => new Promise(r => t.log(info, r));

test('stores warnings and errors, not plain info', async () => {
  const { t, stored } = sink();
  await log(t, { level: 'info', message: 'routine', service: 'lan-agent' });
  await log(t, { level: 'debug', message: 'noise' });
  await log(t, { level: 'warn', message: 'disk at 91%', service: 'system' });
  await log(t, { level: 'error', message: 'Provider call failed: ECONNRESET', service: 'lan-agent', stack: 'Error: x\n at y' });
  await t.flush();
  assert.deepEqual(stored.map(d => d.level), ['warn', 'error']);
  const err = stored[1];
  assert.equal(err.category, 'network');
  assert.equal(err.error.message, 'Provider call failed: ECONNRESET');
  assert.match(err.error.stack, /at y/);
  assert.deepEqual(err.source, { service: 'lan-agent' });
});

test('an info entry is stored when it names a category or opts in', async () => {
  const { t, stored } = sink();
  await log(t, { level: 'info', message: 'scan took 812ms', category: 'performance' });
  await log(t, { level: 'info', message: 'operator note', systemLog: true });
  await log(t, { level: 'info', message: 'bad category', category: 'nonsense' });
  await t.flush();
  assert.deepEqual(stored.map(d => d.message), ['scan took 812ms', 'operator note']);
  assert.equal(stored[0].category, 'performance');
});

test('a flood is collapsed into one summary entry with the count', async () => {
  const { t, stored, advance } = sink();
  for (let i = 0; i < 40; i++) await log(t, { level: 'warn', message: `Network scan failed for bsc: attempt ${i}` });
  await t.flush();
  assert.equal(stored.length, 3, 'the first three are kept individually');
  advance(61_000);
  await t.flush();
  assert.equal(stored.length, 4);
  assert.equal(stored[3].details.suppressed, 37);
  assert.ok(stored[3].tags.includes('flood-summary'));
  assert.match(stored[3].message, /repeated 37 more times/);
});

test('extra fields become details; huge or circular details cannot break it', async () => {
  const { t, stored } = sink();
  const loop = { a: 1 }; loop.self = loop;
  await log(t, { level: 'warn', message: 'with meta', pair: 'WBNB/BUSD', loop, big: 10n });
  await log(t, { level: 'warn', message: 'huge', blob: 'x'.repeat(10_000) });
  await t.flush();
  assert.equal(stored[0].details.pair, 'WBNB/BUSD');
  assert.equal(stored[0].details.loop.self, '[circular]');
  assert.equal(stored[0].details.big, '10');
  assert.ok(stored[1].details.truncated.length <= 4000);
});

test('holds entries while the database is down, bounded, and reports the drop', async () => {
  let up = false;
  const { t, stored } = sink({ isConnected: () => up });
  for (let i = 0; i < 1005; i++) await log(t, { level: 'warn', message: `distinct ${'abcdefghij'[i % 10]}${i}`.replace(/\d/g, (d) => 'klmnopqrst'[d]) });
  assert.equal(await t.flush(), 0, 'nothing written while disconnected');
  assert.equal(t.buffer.length, 1000);
  up = true;
  while (t.buffer.length) await t.flush();
  assert.ok(stored.some(d => /dropped 5 entries/.test(d.message)));
});

test('a failed insert is kept for retry, never thrown, and complains at most once per 5 minutes', async () => {
  let fail = true;
  const written = [];
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    const { t } = sink({ insertMany: async (docs) => { if (fail) throw new Error('not primary'); written.push(...docs); } });
    await log(t, { level: 'error', message: 'one' });
    assert.equal(await t.flush(), 0);
    await log(t, { level: 'error', message: 'two' });
    assert.equal(await t.flush(), 0);
    assert.equal(lines.filter(l => l.includes('[system-log]')).length, 1);
    fail = false;
    await t.flush();
    assert.deepEqual(written.map(d => d.message), ['one', 'two']);
  } finally {
    process.stderr.write = orig;
  }
});

test('log() never throws, even on a hostile entry', async () => {
  const { t } = sink();
  const hostile = { level: 'warn', get message() { throw new Error('boom'); } };
  await assert.doesNotReject(log(t, hostile));
});

test('categorize sorts common failures', () => {
  assert.equal(categorize('self-modification', 'PR failed'), 'update');
  assert.equal(categorize('api', 'Unauthorized request from 10.0.0.5'), 'security');
  assert.equal(categorize('lan-agent', 'getaddrinfo EAI_AGAIN api.example.com'), 'network');
  assert.equal(categorize('lan-agent', 'OpenRouter returned 429'), 'ai');
  assert.equal(categorize('lan-agent', 'AI provider fallback: anthropic timed out'), 'ai');
  assert.equal(categorize('lan-agent', 'oauthmanager: no providers configured at serviceConfigs'), 'system');
  assert.equal(categorize('lan-agent', 'Alert: High response time - Average response time exceeded'), 'performance');
  assert.equal(categorize('lan-agent', 'Something odd'), 'system');
});

test('propagates correlationId when present', async () => {
  const { t, stored } = sink();
  await log(t, { level: 'warn', message: 'something', correlationId: 'req-123' });
  await log(t, { level: 'error', message: 'another', correlationId: '' });
  await log(t, { level: 'info', message: 'info with correlationId', category: 'performance', correlationId: 'req-456' });
  await t.flush();
  assert.equal(stored[0].context.requestId, 'req-123');
  assert.equal(stored[1].context, undefined);
  assert.equal(stored[2].context.requestId, 'req-456');
});

test('correlationId is only propagated if a non-empty string', async () => {
  const { t, stored } = sink();
  await log(t, { level: 'warn', message: 'a', correlationId: 123 });
  await log(t, { level: 'warn', message: 'b', correlationId: null });
  await log(t, { level: 'warn', message: 'c', correlationId: 'valid' });
  await t.flush();
  assert.equal(stored[0].context, undefined);
  assert.equal(stored[1].context, undefined);
  assert.equal(stored[2].context.requestId, 'valid');
  assert.equal(stored[0].details.correlationId, 123, 'a non-string id stays in details');
  assert.equal(stored[2].details, undefined, 'the id is not duplicated into details');
});

test('requestId is accepted as the same thing', async () => {
  const { t, stored } = sink();
  await log(t, { level: 'warn', message: 'r', requestId: 'req-789' });
  await t.flush();
  assert.equal(stored[0].context.requestId, 'req-789');
});

test('a correlated entry passes the real SystemLog schema with the id intact', async () => {
  const { SystemLog } = await import('../../src/models/SystemLog.js');
  const { t, stored } = sink();
  await log(t, { level: 'warn', message: 'schema check', correlationId: 'req-abc' });
  await t.flush();
  const docModel = new SystemLog(stored[0]);
  assert.equal(docModel.validateSync(), undefined);
  assert.equal(docModel.context.requestId, 'req-abc');
});
