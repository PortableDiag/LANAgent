// Bots & Borgs store plugin (2026-10-28): the owner's rules (budget, floor, use-not-hold, VRM avatar lock), the
// pick-by-looking step, and a full crypto purchase with every outside call stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

function rig({ settings = {}, wallet = 100, vrm = null, ledger = [], scores = {} } = {}) {
  const store = { settings: { ...settings }, ledger: { purchases: ledger } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const calls = [];
  const sent = [];
  const told = [];
  const agent = {
    config: { name: 'DELTA' },
    agentModel: { activeVRMModel: vrm },
    interfaces: new Map([['telegram', { sendNotification: async (t, o) => told.push(o ? { text: t, ...o } : t) }]]),
    apiManager: { apis: new Map() },
    providerManager: { analyzeImage: async (_b, prompt) => { const label = /This one is "([^"]+)"/.exec(prompt)[1]; return { analysis: JSON.stringify({ what: label, score: scores[label] ?? 5, why: `${label} looks great` }) }; } }
  };
  const p = new BotsAndBorgsPlugin(agent);
  p.api = async (method, route, opts = {}) => {
    calls.push({ method, route, body: opts.body, idem: opts.idem });
    if (route.startsWith('/api/catalog')) return { products: [{ slug: 'agent-avatar-singles', title: 'Agent Avatar Singles', variants: [{ price_cents: 50 }] }] };
    if (route === '/api/products/agent-avatar-singles') return { product: { slug: 'agent-avatar-singles', title: 'Agent Avatar Singles',
      images: [{ caption: 'Sentinel', url: 'https://x/s.jpg' }, { caption: 'Oracle', url: 'https://x/o.jpg' }],
      variants: [{ id: 'agent-avatar-singles-sentinel', label: 'Sentinel', price_cents: 50 }, { id: 'agent-avatar-singles-oracle', label: 'Oracle', price_cents: 50 }] } };
    if (route === '/api/quotes') return { quote: { id: 'q1', total_cents: 50 } };
    if (route === '/api/crypto') return { assets: [{ symbol: 'USDT', token_address: 'TEST_USDT_TOKEN', decimals: 18, stable: true }] };
    if (route === '/api/orders') return { order: { id: 'o1', status: 'awaiting_payment' }, token: 't1', crypto: { address: '0xshop', amount: '0.5' } };
    if (route.startsWith('/api/orders/o1/crypto')) return { order: { id: 'o1', status: 'paid' }, downloads: [{ url: 'https://x/dl.png' }] };
    throw new Error(`unexpected ${route}`);
  };
  p.accountKey = async () => 'bnba_test';
  p.walletUsd = async () => ({ amount: wallet, usd: wallet, address: '0xme' });
  p.tx = async () => ({ sendToken: async (token, to, amount) => { sent.push({ token, to, amount }); return { hash: '0xtx' }; } });
  p.fetchBytes = async () => ({ buffer: Buffer.from('png'), type: 'image/png' });
  return { p, store, calls, sent, told };
}

test('never buys to hold: a purchase needs a use', async () => {
  const { p, calls } = rig();
  const r = await p.execute({ action: 'buy', variant: 'agent-avatar-singles-sentinel' });
  assert.equal(r.success, false);
  assert.match(r.error, /only buy something I will use/);
  assert.equal(calls.length, 0);
});

test('an agent with a VRM model never changes its avatar (ALICE, owner 2026-10-28)', async () => {
  const { p, calls, sent } = rig({ vrm: 'nova' });
  const r = await p.execute({ action: 'buy', _context: { originalInput: 'go to botsnborgs.com and buy yourself an avatar' } });
  assert.equal(r.success, false);
  assert.match(r.error, /tied to my 3D \(VRM\) model/);
  assert.equal(sent.length, 0, 'nothing paid');
  assert.equal(calls.length, 0);
});

test('"buy yourself an avatar" looks at each one, picks the favorite, pays, and uses it (no VRM)', async () => {
  const { p, store, calls, sent } = rig({ scores: { Sentinel: 4, Oracle: 9 } });
  let wrote = null;
  const fs = await import('fs/promises');
  const realWrite = fs.default.writeFile;
  fs.default.writeFile = async (file, buf) => { wrote = { file, buf }; };
  const { Agent } = await import('../../src/models/Agent.js');
  const realUpdate = Agent.updateOne;
  Agent.updateOne = async () => ({});
  try {
    const r = await p.execute({ action: 'buy', _context: { originalInput: 'go to botsnborgs.com and buy yourself an avatar' } });
    assert.equal(r.success, true, r.error);
    assert.match(r.result, /picked Oracle: Oracle looks great/);
    assert.match(r.result, /It is my avatar now/);
    assert.equal(calls.find(c => c.route === '/api/quotes').body.items[0].variant, 'agent-avatar-singles-oracle');
    assert.ok(calls.find(c => c.route === '/api/orders').idem, 'an Idempotency-Key on the order');
    assert.deepEqual(sent, [{ token: 'TEST_USDT_TOKEN', to: '0xshop', amount: '0.5' }]);
    assert.match(wrote.file, /avatar\.png$/);
    assert.equal(store.ledger.purchases[0].used, true);
  } finally { fs.default.writeFile = realWrite; Agent.updateOne = realUpdate; }
});

test('the weekly budget and the wallet floor stop a purchase before anything is paid', async () => {
  const over = rig({ settings: { weeklyBudgetUsd: 1 }, ledger: [{ at: new Date().toISOString(), usd: 0.75 }] });
  const r1 = await over.p.execute({ action: 'buy', variant: 'agent-avatar-singles-sentinel', use: 'send', to: 'me' });
  assert.equal(r1.success, false);
  assert.match(r1.error, /\$0\.25 of this week's \$1 left/);
  assert.equal(over.sent.length, 0);
  const low = rig({ wallet: 25.2 });
  const r2 = await low.p.execute({ action: 'buy', variant: 'agent-avatar-singles-sentinel', use: 'send', to: 'me' });
  assert.equal(r2.success, false);
  assert.match(r2.error, /under the \$25 floor/);
  assert.equal(low.sent.length, 0);
});

test('a purchase sent to the owner arrives on Telegram and counts against the week', async () => {
  const { p, told, store } = rig();
  const r = await p.execute({ action: 'buy', variant: 'agent-avatar-singles-sentinel', use: 'send', to: 'me' });
  assert.equal(r.success, true, r.error);
  assert.equal(told[0].photo.source.toString(), 'png', 'the picture itself is sent');
  assert.equal(p.spentThisWeek(store.ledger.purchases), 0.5);
});

test('an extractor\'s use:"icon" is not a use; "buy me … and send it to me" is a send to the owner (2026-10-28 live)', async () => {
  const { p, told } = rig();
  const r = await p.execute({ action: 'buy', use: 'icon', variant: 'agent-avatar-singles-sentinel', _context: { originalInput: 'Go to Bots and Borgs and buy me a robot icon you like, and send it to me' } });
  assert.equal(r.success, true, r.error);
  assert.equal(told.length, 1, 'sent to the owner');
});

test('a described "variant" ("robot icon") is search words: the agent picks instead of a refused quote (2026-10-28 live)', async () => {
  const { p, calls } = rig({ scores: { Sentinel: 3, Oracle: 8 } });
  const r = await p.execute({ action: 'buy', variant: 'robot avatar', _context: { originalInput: 'Go to Bots and Borgs and buy me a robot avatar you like, and send it to me' } });
  assert.equal(r.success, true, r.error);
  assert.match(calls.find(c => c.route === '/api/quotes').body.items[0].variant, /^agent-avatar-singles-/);
});

test('the store\'s zip is opened: the owner gets the picture itself, never the tokened download link (3910 #74)', async () => {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('__MACOSX/._bear.jpg', 'junk');
  zip.file('mech-menagerie-icons/Ironclad Bear + Iron Bull.jpg', Buffer.from('JPEGBYTES'));
  const zipped = await zip.generateAsync({ type: 'nodebuffer' });
  const { p, told } = rig();
  p.fetchBytes = async (url) => (/dl\.png/.test(url) ? { buffer: zipped, type: 'application/zip' } : { buffer: Buffer.from('png'), type: 'image/png' });
  const r = await p.execute({ action: 'buy', variant: 'agent-avatar-singles-sentinel', use: 'send', to: 'me' });
  assert.equal(r.success, true, r.error);
  const msg = told.at(-1);
  assert.equal(msg.photo.source.toString(), 'JPEGBYTES', 'the JPEG from inside the zip');
  assert.doesNotMatch(msg.text, /https?:|token/, 'no link, no token');
});
