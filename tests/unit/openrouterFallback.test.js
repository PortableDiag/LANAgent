/** Drops are common: a stalled or failing model hands over to another, never silently repeats itself. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APIConnectionTimeoutError } from 'openai';
import { OpenRouterProvider } from '../../src/providers/openrouter.js';

function rig(failures) {
  const p = new OpenRouterProvider({ apiKey: 'k', chatModel: 'main/model', zdrFallbackModel: 'other/model' });
  p.zdrFallbackModel = 'other/model';
  p.models.chat = 'main/model';
  const calls = [];
  p.client = { chat: { completions: { create: async (params, opts) => {
    calls.push({ model: params.model, opts });
    const f = failures.shift();
    if (f) throw f;
    return { model: params.model, choices: [{ message: { content: `from ${params.model}` }, finish_reason: 'stop' }], usage: {} };
  } } } };
  return { p, calls };
}
const status = (n) => Object.assign(new Error(`${n} upstream`), { status: n });

test('a healthy call uses the chat model once, with no silent SDK retries and a short first try', async () => {
  const { p, calls } = rig([]);
  const r = await p.generateResponse('hi', { maxTokens: 200 });
  assert.equal(r.content, 'from main/model');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.maxRetries, 0);
  assert.equal(calls[0].opts.timeout, 45000);
});

for (const [name, err] of [
  ['a stall', new APIConnectionTimeoutError({ message: 'Request timed out.' })],
  ['a 429', status(429)], ['a 502', status(502)], ['a 503', status(503)]
]) {
  test(`${name} moves to another model at once`, async () => {
    const { p, calls } = rig([err]);
    const r = await p.generateResponse('hi', { maxTokens: 200 });
    assert.equal(r.content, 'from other/model');
    assert.deepEqual(calls.map(c => c.model), ['main/model', 'other/model']);
    assert.equal(calls[1].opts.timeout, p._generationTimeoutMs(200), 'the last try gets the full budget');
  });
}

test('an empty answer counts as a failure too', async () => {
  const { p, calls } = rig([]);
  let n = 0;
  const create = p.client.chat.completions.create;
  p.client.chat.completions.create = async (a, b) => (n++ === 0 ? (calls.push({ model: a.model }), { choices: [] }) : create(a, b));
  assert.equal((await p.generateResponse('hi', { maxTokens: 200 })).content, 'from other/model');
});

test('credit and key errors stop: another model would not help', async () => {
  for (const code of [401, 402, 403]) {
    const { p, calls } = rig([status(code)]);
    await assert.rejects(() => p.generateResponse('hi', { maxTokens: 200 }));
    assert.equal(calls.length, 1, String(code));
  }
});

test('when the fallback model itself drops, the chat model is next; both failing surfaces the error', async () => {
  const { p } = rig([]);
  assert.equal(p._nextModel(status(503), 'other/model'), 'main/model');
  const { p: q, calls } = rig([status(503), status(503)]);
  await assert.rejects(() => q.generateResponse('hi', { maxTokens: 200 }));
  assert.equal(calls.length, 2);
});

test('a long generation keeps room to finish', () => {
  const { p } = rig([]);
  assert.equal(p._firstTryMs(200), 45000);
  assert.ok(p._firstTryMs(8000) > 150000);
  assert.ok(p._firstTryMs(8000) <= p._generationTimeoutMs(8000));
});

// The owner's "waving and saying hello" video, 2026-11-23: the model thought for 4000 tokens and said nothing, and the
// empty answer went on as if it were one.
test('an answer with no words moves to another model; a tool call or the other model being empty too does not loop', async () => {
  for (const content of ['', '   ', null]) {
    const { p, calls } = rig([]); let n = 0; const create = p.client.chat.completions.create;
    p.client.chat.completions.create = async (a, b) => (n++ === 0 ? (calls.push({ model: a.model }), { model: a.model, choices: [{ message: { content }, finish_reason: 'length' }], usage: { completion_tokens: 4000 } }) : create(a, b));
    assert.equal((await p.generateResponse('hi', { maxTokens: 120 })).content, 'from other/model');
    assert.deepEqual(calls.map(c => c.model), ['main/model', 'other/model']);
  }
  const t = rig([]); t.p.client.chat.completions.create = async (a) => { t.calls.push({ model: a.model }); return { model: a.model, choices: [{ message: { content: null, tool_calls: [{ id: 'x' }] } }], usage: {} }; };
  await t.p.generateResponse('hi', { maxTokens: 120 }); assert.equal(t.calls.length, 1);
  const e = rig([]); e.p.client.chat.completions.create = async (a) => { e.calls.push({ model: a.model }); return { model: a.model, choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: {} }; };
  assert.equal((await e.p.generateResponse('hi', { maxTokens: 120 })).content, ''); assert.equal(e.calls.length, 2);
});

test('noReasoning turns thinking off only where the model allows it', async () => {
  const { p } = rig([]);
  p.catalog = new Map([['main/model', { supportsReasoning: true, reasoningOptional: true, inputModalities: [] }], ['must/think', { supportsReasoning: true, reasoningOptional: false, inputModalities: [] }]]);
  const off = p._buildParams('hi', { maxTokens: 120, noReasoning: true }).params;
  assert.deepEqual(off.reasoning, { enabled: false }); assert.equal(off.max_tokens, 120);
  const must = p._buildParams('hi', { maxTokens: 120, noReasoning: true, model: 'must/think' }).params;
  assert.equal(must.reasoning, undefined); assert.equal(must.max_tokens, 4000);
  assert.equal(p._buildParams('hi', { maxTokens: 120 }).params.max_tokens, 4000, 'every other call keeps its thinking');
});
