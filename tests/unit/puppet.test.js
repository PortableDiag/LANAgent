// Live puppeting (Bots & Borgs 0.57): the agent's publisher and the plugin's command, token and body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PuppetPublisher, cleanCommand, bodyKey } from '../../src/services/avatar/puppet.js';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

class FakeWS extends EventEmitter {
  static last = null;
  constructor(url) { super(); this.url = url; this.sent = []; FakeWS.last = this; setImmediate(() => this.emit('open')); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.emit('close'); }
}
const tick = () => new Promise(r => setImmediate(r));
const quiet = { info() {}, warn() {} };

test('commands keep only the fields the runtime knows; an unknown pose or a huge command is refused', () => {
  assert.deepEqual(cleanCommand({ pose: 'wave', bogus: 1, hold: 6 }), { pose: 'wave', hold: 6 });
  assert.equal(cleanCommand({ pose: 'moonwalk' }), null);
  assert.equal(cleanCommand({ hands: { right: { at: { landmark: 'x'.repeat(5000) } } } }), null);
  assert.equal(cleanCommand(null), null);
  assert.equal(bodyKey({ live: 'vrm-a' }), 'owner|{"live":"vrm-a"}');
});

test('the publisher authenticates first, sends once ready, merges commands within the 30-a-second gap, stops on unauthorized', async (t) => {
  const p = new PuppetPublisher({ key: 'bnba_k', avatar: { live: 'vrm-a' }, WebSocketImpl: FakeWS, log: quiet });
  p.send({ pose: 'wave' });
  await tick();
  const ws = FakeWS.last;
  assert.deepEqual(ws.sent[0], { auth: 'bnba_k', avatar: { live: 'vrm-a' }, stream: 'owner' });
  assert.equal(ws.sent.length, 1, 'nothing before ready');
  ws.emit('message', JSON.stringify({ ready: { vrm_sha256: 'abc', viewers: 2 } }));
  assert.deepEqual(ws.sent[1], { pose: 'wave' });
  assert.equal(p.viewers, 2);
  // Two more at once: merged, the latest field wins, sent after the gap.
  p.send({ mood: { happy: 0.5 } });
  p.send({ mood: { happy: 0.9 }, gaze: { camera: true } });
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(ws.sent.slice(2), [{ mood: { happy: 0.9 }, gaze: { camera: true } }]);
  ws.emit('message', JSON.stringify({ error: 'unauthorized' }));
  assert.equal(p.closed, true);
  p.close();
});

function plugin({ worn = 'store-vrm-racer-blue-bundle', passes = [], links = [] } = {}) {
  const store = { live: { passes }, links: { links } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const p = new BotsAndBorgsPlugin({ agentModel: { activeVRMModel: worn } });
  p.accountKey = async () => 'bnba_k';
  return p;
}

test('the body to puppet: a linked outfit, else the live pass, else the store product; none for a non-store model', async () => {
  assert.deepEqual(await plugin({ passes: [{ slug: 'vrm-racer-blue-live30', key: 'x', state: 'active' }] }).puppetBody(), { live: 'vrm-racer-blue-live30' });
  assert.deepEqual(await plugin().puppetBody(), { product: 'vrm-racer-blue' });
  assert.deepEqual(await plugin({ worn: 'store-linked-lnk-1-rose-base', links: [{ id: 'lnk_1', outfits: [{ model: 'rose', outfit: 'base', modelId: 'store-linked-lnk-1-rose-base' }] }] }).puppetBody(),
    { link: 'lnk_1', model: 'rose', outfit: 'base' });
  assert.equal(await plugin({ worn: 'nova' }).puppetBody(), null);
});

test('the page\'s viewer token: the owner stream only, kept until near its end', async () => {
  const p = plugin();
  const calls = [];
  p.api = async (method, route, opts) => { calls.push({ route, body: opts.body }); return { token: 'bnbv_t', ws: 'wss://x/ws', rig: 'https://x/rig', expires: Math.floor(Date.now() / 1000) + 3600 }; };
  p.http = async (req) => { assert.equal(req.headers.Authorization, 'Bearer bnbv_t'); return { status: 200, data: { landmarks: { nose: {} } } }; };
  const v = await p.puppetViewer();
  assert.equal(v.token, 'bnbv_t');
  assert.deepEqual(v.rigData, { landmarks: { nose: {} } }, 'the rig comes with the token (no cross-origin fetch in the page)');
  assert.deepEqual(calls[0].body, { avatar: { product: 'vrm-racer-blue' }, stream: 'owner', ttl: 3600 });
  await p.puppetViewer();
  assert.equal(calls.length, 1, 'kept, not minted again');
});

test('"wave" is a named pose; "stop posing" releases; a described pose is written by the model', async () => {
  const p = plugin();
  const sent = [];
  p.PuppetPublisherImpl = class { constructor() { this.viewers = 1; this.closed = false; } send(c) { sent.push(cleanCommand(c)); return true; } close() {} };
  assert.equal((await p.puppetCommand({ pose: 'wave' })).success, true);
  await p.puppetCommand({ do: 'stop posing' });
  p.agent.providerManager = { generateResponse: async () => ({ content: '{"point_at":{"landmark":"nose"},"mood":{"happy":0.4}}' }) };
  await p.puppetCommand({ do: 'point at your nose' });
  assert.deepEqual(sent, [{ pose: 'wave', hold: 6 }, { release: true }, { point_at: { landmark: 'nose' }, mood: { happy: 0.4 }, hold: 6 }]);
});

test('a rig still being measured: the page is told to come back, and gets the rig once it is ready', async () => {
  const p = plugin();
  p.api = async () => ({ token: 'bnbv_t', ws: 'wss://x/ws', rig: 'https://x/rig', expires: Math.floor(Date.now() / 1000) + 3600 });
  let ready = false;
  p.http = async () => (ready ? { status: 200, data: { landmarks: {} } } : { status: 202, data: { pending: true, retry_after: 15, line: 'being measured' } });
  const first = await p.puppetViewer();
  assert.equal(first.pending, true);
  assert.equal(first.retry_after, 15);
  assert.equal(first.rigData, undefined);
  ready = true;
  const second = await p.puppetViewer();
  assert.deepEqual(second.rigData, { landmarks: {} });
  assert.equal(second.pending, undefined);
});
