// ALICE failing simple Trellis tasks (2026-09-30, WebNotes channel card 21):
//  #919 "build a frog lifecycle diagram with connected image cards" → a 7-step plan exceeded
//       the chain limit, fell to a tool-less answer, and replied with a promise.
//  #923 "@agents each of you post a card with a purple frog" → planned "have each agent post",
//       listed its internal sub-agents into the channel, and createImageCard failed on the stale
//       default basket "ALICE"; the request was marked completed.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import TrellisNotesPlugin from '../../src/api/plugins/trellis-notes.js';
import { TrellisChannelListener } from '../../src/services/trellisChannelListener.js';
import { PluginChainProcessor } from '../../src/core/pluginChainProcessor.js';
import { executeTool } from '../../src/services/reasoning/toolCatalog.js';

const realRequest = axios.request;
afterEach(() => { axios.request = realRequest; });

const DOC = '3b343a37-0000-4000-8000-000000000001';
// An account-wide key: several top-level baskets, none called "ALICE".
const TREE = { roots: [
  { id: 1, title: 'LANAgent Ecosystem', cards: 1, children: [] },
  { id: 3, title: 'WebNotes', cards: 4, children: [{ id: 5, title: 'AgentTests', cards: 9, children: [] }] }
] };

function serve(routes) {
  const calls = [];
  axios.request = async (cfg) => {
    const u = new URL(cfg.url);
    const key = `${cfg.method.toUpperCase()} ${u.pathname}`;
    calls.push({ key, query: Object.fromEntries(u.searchParams), body: cfg.data });
    const r = routes[key];
    if (r === undefined) return { status: 404, data: { error: 'no such API route' } };
    const data = typeof r === 'function' ? r(cfg, u) : r;
    return { status: data?.__status || 200, data };
  };
  return calls;
}
const WEB = {
  'GET /api/instance': { app: 'trellis-web', version: '0.78.0' },
  'GET /api/agent': { documents: [{ id: DOC, name: 'WebNotes', access: 'owner' }] },
  'GET /api/tree': TREE
};
function plugin() {
  const p = new TrellisNotesPlugin({});
  p.credentials = { apiKey: 'tk_test' };
  Object.assign(p.config, { baseUrl: 'https://trellis-cards.com', mode: 'auto', document: DOC, defaultBasket: 'ALICE' });
  return p;
}

test('a card asked for in a channel lands in that channel\'s basket, not the stale default', async () => {
  const calls = serve({ ...WEB, 'GET /api/cards/21': { card: { id: 21, node: 5 }, node: 5 }, 'POST /api/nodes/5/cards': { __status: 201, id: 300 } });
  const r = await plugin().execute({ action: 'createNote', title: 'Purple frog', body: 'x', _trellis: { document: DOC, card: 21 } });
  assert.equal(r.success, true, r.error);
  assert.ok(calls.some(c => c.key === 'POST /api/nodes/5/cards'), 'created in the channel card\'s basket');
  assert.ok(!calls.some(c => JSON.stringify(c.body || {}).includes('_trellis')), 'the channel context is never sent to the server');
});

test('without a channel the old behaviour stands (and says why it failed)', async () => {
  serve({ ...WEB });
  const r = await plugin().execute({ action: 'createNote', title: 'x', body: 'y' });
  assert.equal(r.success, false);
  assert.match(r.error, /The default basket "ALICE" was not found/);
});

test('a named basket is still honoured from a channel', async () => {
  const calls = serve({ ...WEB, 'GET /api/cards/21': { node: 1 }, 'POST /api/nodes/5/cards': { __status: 201, id: 301 } });
  const r = await plugin().execute({ action: 'createNote', basket: 'AgentTests', title: 'x', body: 'y', _trellis: { document: DOC, card: 21 } });
  assert.equal(r.success, true, r.error);
  assert.ok(calls.some(c => c.key === 'POST /api/nodes/5/cards'));
});

test('connectCards joins two cards of one basket, and refuses across baskets', async () => {
  const calls = serve({ ...WEB,
    'GET /api/cards/189': { node: 5 }, 'GET /api/cards/190': { node: 5 }, 'GET /api/cards/400': { node: 3 },
    'POST /api/nodes/5/connectors': { __status: 201, id: 7, from: 189, to: 190, label: 'hatches' } });
  const p = plugin();
  assert.ok(p.commands.some(c => c.command === 'connectCards') && p.commands.some(c => c.command === 'layoutFlow'));
  const r = await p.execute({ action: 'connectCards', from: 189, to: 190, label: 'hatches', style: 'dashed' });
  assert.equal(r.success, true, r.error);
  const post = calls.find(c => c.key === 'POST /api/nodes/5/connectors');
  assert.deepEqual(JSON.parse(typeof post.body === 'string' ? post.body : JSON.stringify(post.body)), { from: 189, to: 190, label: 'hatches', style: 'dashed' });
  const bad = await p.execute({ action: 'connectCards', from: 189, to: 400 });
  assert.equal(bad.success, false);
  assert.match(bad.error, /different baskets/);
  assert.equal((await p.execute({ action: 'connectCards', from: 189, to: 189 })).success, false);
});

test('layoutFlow lays out the channel basket as a flowchart', async () => {
  const calls = serve({ ...WEB, 'GET /api/cards/21': { node: 5 }, 'POST /api/nodes/5/layout': { moved: 5, positions: [] } });
  const r = await plugin().execute({ action: 'layoutFlow', dir: 'right', _trellis: { document: DOC, card: 21 } });
  assert.equal(r.success, true, r.error);
  const post = calls.find(c => c.key === 'POST /api/nodes/5/layout');
  assert.deepEqual(JSON.parse(typeof post.body === 'string' ? post.body : JSON.stringify(post.body)), { kind: 'flow', dir: 'right' });
});

function listener(result) {
  const said = []; const states = [];
  const channel = { group: true, messages: [{ seq: 923, from: 'owner-handle', kind: 'person', via: 'session', from_key_owner: true, to: ['Outrider', 'Alice', 'trellis'], at: '2026-09-30T00:00:00Z', text: '@agents each of you post a card with a picture of a purple frog' }] };
  let input = null;
  const plugin = {
    resolvedMode: 'web',
    _agentName: () => 'Alice',
    _call: async (method, path, opts = {}) => {
      if (path.endsWith('/state')) { states.push(opts.body.state + (opts.body.note ? `:${opts.body.note}` : '')); return {}; }
      if (path.endsWith('/react')) return {};
      if (method === 'get') return channel;
      if (path.endsWith('/say')) { said.push(opts.body.text); return { seq: 924 }; }
      return {};
    },
    agent: {
      processNaturalLanguage: async (text) => { input = text; return result; },
      providerManager: { generateResponse: async () => ({ content: '{}' }) },
      memoryManager: null
    }
  };
  const l = new TrellisChannelListener(plugin);
  l._teacher = () => ({ consider: async () => null });
  l._isOperator = async () => true;
  return { l, said, states, input: () => input };
}

test('a shared task tells ALICE to do only its own part', () => {
  const { l } = listener({});
  const note = l._sharedTaskNote({ to: ['Outrider', 'Alice', 'trellis'], text: '@agents each of you post a card' });
  assert.match(note, /also goes to Outrider, trellis/);
  assert.match(note, /Do only your own part/);
  assert.match(note, /do not list or describe your own internal sub-agents/);
  assert.equal(l._sharedTaskNote({ to: ['Alice'], text: '@Alice post a card' }), '', 'a message for ALICE alone gets no note');
});

test('a request that did not finish is marked failed, with the reason', async () => {
  const { l, said, states, input } = listener({ success: false, content: '⚠️ **Not finished:** post the card — No basket matching "ALICE".' });
  await l._handleChannel({ id: DOC }, 21, `${DOC}:21`);
  await new Promise(r => setTimeout(r, 40));
  assert.match(input(), /Do only your own part, as Alice/);
  assert.equal(said.length, 1);
  assert.deepEqual(states, ['working', 'failed:did not finish; see the reply']);
});

test('a request that finished is still completed', async () => {
  const { l, states } = listener({ success: true, content: 'Posted card #500.' });
  await l._handleChannel({ id: DOC }, 21, `${DOC}:21`);
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(states, ['working', 'completed']);
});

test('a chain that stopped says so first', () => {
  const p = Object.create(PluginChainProcessor.prototype);
  const summary = p.generateChainSummary([
    { stepNumber: 1, success: true, description: 'Search for a photo', result: 'x'.repeat(1400) },
    { stepNumber: 2, success: false, description: 'Post the card', error: 'No basket matching "ALICE".' }
  ], false);
  assert.match(summary.split('\n')[0], /^⚠️ \*\*Not finished:\*\* Post the card — No basket matching "ALICE"\./);
});

test('the reasoning path passes the channel to trellis-notes only', async () => {
  const seen = [];
  const agent = {
    apiManager: {
      apis: new Map([['trellis-notes', { enabled: true, instance: { commands: [{ command: 'createNote', description: 'x' }] } }],
                     ['websearch', { enabled: true, instance: { commands: [{ command: 'search', description: 'x' }] } }]]),
      executeAPI: async (tool, m, params) => { seen.push([tool, params]); return { success: true }; }
    }
  };
  const ctx = { trellis: { document: DOC, card: 21 } };
  await executeTool(agent, 'trellis-notes', 'createNote', { title: 't' }, ctx).catch(() => {});
  await executeTool(agent, 'websearch', 'search', { query: 'q' }, ctx).catch(() => {});
  const tn = seen.find(s => s[0] === 'trellis-notes'); const ws = seen.find(s => s[0] === 'websearch');
  assert.ok(tn && ws, 'both tools ran');
  assert.deepEqual(tn[1]._trellis, ctx.trellis);
  assert.equal(ws[1]._trellis, undefined, 'never sent to other plugins');
});

test('a note naming a basket that does not exist goes to the default and says so (call 70: basket "Pat")', async () => {
  const calls = serve({ ...WEB, 'POST /api/nodes/5/cards': { __status: 201, id: 302 } });
  const p = plugin();
  p.config.defaultBasket = 5;
  const r = await p.execute({ action: 'createNote', basket: 'Pat', title: 'Hunt items to find', kind: 'checklist',
    body: 'a running checklist with: 1) a small trinket-like orb, 2) a little goose-like origami thing.' });
  assert.equal(r.success, true, r.error);
  const post = calls.find(c => c.key === 'POST /api/nodes/5/cards');
  assert.ok(post, 'created in the default basket');
  const sent = typeof post.body === 'string' ? JSON.parse(post.body) : post.body;
  assert.deepEqual(sent.items.map(i => i.text), ['a small trinket-like orb', 'a little goose-like origami thing']);
  assert.match(JSON.stringify(r), /No basket is called \\"Pat\\"/);
});

test('a note with no title is titled from its first words (call 75: "createNote needs a title")', async () => {
  const calls = serve({ ...WEB, 'POST /api/nodes/5/cards': { __status: 201, id: 303 } });
  const p = plugin();
  p.config.defaultBasket = 5;
  const r = await p.execute({ action: 'createNote', body: 'The mouse will arrive at midnight with the frozen cheese.' });
  assert.equal(r.success, true, r.error);
  const post = calls.find(c => c.key === 'POST /api/nodes/5/cards');
  const sent = typeof post.body === 'string' ? JSON.parse(post.body) : post.body;
  assert.equal(sent.title, 'The mouse will arrive at midnight…');
  assert.equal(sent.body, 'The mouse will arrive at midnight with the frozen cheese.');
});

test('"what are the notes?" reads back the notes the agent took, newest first, never makes one (call 83)', async () => {
  const { asksForNotes } = await import('../../src/api/plugins/trellis-notes.js');
  assert.equal(asksForNotes('Pat asked: "What are the notes?" Please retrieve Pat\'s notes from Trellis'), true);
  assert.equal(asksForNotes('Do you have any notes for me?'), true);
  assert.equal(asksForNotes('Take a note: the drywall guy comes Thursday'), false);
  const { PluginSettings } = await import('../../src/models/PluginSettings.js');
  let stored = null;
  const realGet = PluginSettings.getCached, realSet = PluginSettings.setCached;
  PluginSettings.getCached = async () => stored;
  PluginSettings.setCached = async (_p, _k, v) => { stored = v; };
  try {
    let next = 700;
    const bodies = {};
    const calls = serve({ ...WEB,
      'POST /api/nodes/5/cards': (cfg) => { const b = typeof cfg.data === 'string' ? JSON.parse(cfg.data) : cfg.data; const id = next++; bodies[id] = b; return { __status: 201, id }; },
      'GET /api/cards/700': () => ({ card: { id: 700, title: bodies[700].title, body: bodies[700].body } }),
      'GET /api/cards/701': () => ({ card: { id: 701, title: bodies[701].title, body: bodies[701].body } }) });
    const p = plugin();
    p.config.defaultBasket = 5;
    await p.execute({ action: 'createNote', title: 'Mouse', body: 'The mouse arrives at midnight.' });
    await p.execute({ action: 'createNote', title: 'Drywall', body: 'Drywall guy Thursday at 9.' });
    const before = calls.filter(c => c.key === 'POST /api/nodes/5/cards').length;
    const r = await p.execute({ action: 'createNote', _context: { originalInput: 'What are the notes?' } });
    assert.equal(calls.filter(c => c.key === 'POST /api/nodes/5/cards').length, before, 'no card made');
    assert.match(r.result, /1\. Drywall .*Drywall guy Thursday at 9\.\n2\. Mouse .*The mouse arrives at midnight\./s);
    const prev = process.env.OWNER_NAME; process.env.OWNER_NAME = 'Pat';
    try {
      const named = await p.execute({ action: 'myNotes', query: "Pat's notes" });
      assert.match(named.result, /Drywall[\s\S]*Mouse/, 'the owner\'s name filters nothing');
    } finally { if (prev === undefined) delete process.env.OWNER_NAME; else process.env.OWNER_NAME = prev; }
  } finally { PluginSettings.getCached = realGet; PluginSettings.setCached = realSet; }
});

test('shared call-note cards: the from:: / call:: / at:: lines are read, not shown as the note (Orbit format, 4293 #488)', async () => {
  const { parseNoteCard } = await import('../../src/api/plugins/trellis-notes.js');
  const p = parseNoteCard('The duck flies at noon.\n\nfrom:: Orbit\ncall:: 88\nat:: 2026-10-28T21:05:00Z');
  assert.deepEqual(p, { text: 'The duck flies at noon.', from: 'Orbit', at: '2026-10-28T21:05:00Z' });
  assert.deepEqual(parseNoteCard('Plain note'), { text: 'Plain note', from: null, at: null });
});
