// Live avatar passes: the store hosts a model and serves its newest version to the pass's key (ETag, 304, 402).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BotsAndBorgsPlugin, { livePassList, liveUrl, liveExpiry } from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';
import { livePass, variantKind } from '../../src/services/store/assetLibrary.js';
import { encrypt } from '../../src/utils/encryption.js';

function glb(json) {
  const body = Buffer.from(JSON.stringify(json));
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + body.length, 8);
  head.writeUInt32LE(body.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, body]);
}
const vrm = (name) => glb({ extensions: { VRMC_vrm: { meta: { name }, humanoid: { humanBones: { hips: {}, head: {} } }, expressions: { preset: { happy: {} } } } } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-live-'));

function plugin() {
  const store = {};
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const p = new BotsAndBorgsPlugin({ agentModel: { activeVRMModel: 'other' } });
  p.libraryRoot = tmp(); p.vrmRoot = tmp();
  fs.writeFileSync(path.join(p.vrmRoot, 'manifest.json'), '[]');
  p.productOf = async () => ({ title: 'Core — VRM Avatar', collection: '3d-avatars', variants: [{ id: 'vrm-aa-core' }, { id: 'vrm-aa-core-live30' }] });
  p.accountKey = async () => 'bnba_test';
  // The clip library check has its own test; the model tests count only model downloads.
  p.syncLiveClips = async () => null;
  p.syncLiveMedia = async () => [];
  p.syncLibrary = async () => [];
  p.takeNewPacks = async () => [];
  return { p, store };
}

test('a live pass variant names its model and stays a 3D model', () => {
  assert.deepEqual(livePass('vrm-aa-core-live30'), { slug: 'vrm-aa-core', days: 30 });
  assert.deepEqual(livePass('vrm-nr-tracer-live365'), { slug: 'vrm-nr-tracer', days: 365 });
  assert.equal(livePass('vrm-aa-core'), null);
  assert.equal(livePass('vrm-aa-core-bundle'), null);
  assert.equal(variantKind('vrm-aa-core-live90'), 'vrm');
});

test('the live list is read whatever the store wraps it in', () => {
  assert.equal(livePassList([{ key: 'a' }]).length, 1);
  assert.equal(livePassList({ live: [{ key: 'a' }, { key: 'b' }] }).length, 2);
  assert.equal(livePassList({ live: { key: 'a' } }).length, 1);
  assert.equal(livePassList({ passes: [] }).length, 0);
  assert.equal(livePassList(null).length, 0);
});

test('passes from the store are saved with an encrypted key and keep their ETag', async () => {
  const { p, store } = plugin();
  store.live = { passes: [{ slug: 'vrm-aa-core', key: encrypt('bnbl_old'), etag: '"e1"' }] };
  p.api = async () => ({ live: [{ variant: 'vrm-aa-core-live30', key: 'bnbl_new', state: 'active', expires: 1797270951, vrm_url: 'https://botsandborgs.com/api/live/vrm-aa-core/vrm?key=bnbl_new' }] });
  const passes = await p.refreshLivePasses();
  assert.equal(passes.length, 1);
  assert.equal(passes[0].etag, '"e1"');
  assert.notEqual(passes[0].key, 'bnbl_new');
  assert.equal(passes[0].expires, '2026-12-14T17:55:51.000Z');
  assert.equal(passes[0].vrmUrl, 'https://botsandborgs.com/api/live/vrm-aa-core/vrm');
  assert.ok(!JSON.stringify(store.live).includes('bnbl_new'), 'the key is never saved in the clear');
});

test('a new version replaces the model, an unchanged one is a 304, an expired one keeps the model', async () => {
  const { p, store } = plugin();
  store.live = { passes: [{ slug: 'vrm-aa-core', variant: 'vrm-aa-core-live30', key: encrypt('bnbl_x'), vrmUrl: 'https://s/api/live/vrm-aa-core/vrm' }] };
  let answer = { status: 200, headers: { etag: '"v1"', 'x-live-state': 'active' }, data: vrm('Core') };
  const sent = [];
  p.fetchLive = async (url, headers) => { sent.push(headers); return answer; };

  let r = await p.syncLive();
  assert.equal(r[0].status, 'updated');
  const item = (await p.libraryItems())[0];
  assert.equal(item.variant, 'vrm-aa-core');
  assert.equal(item.files[0].modelId, 'store-vrm-aa-core');
  assert.ok(fs.existsSync(path.join(p.vrmRoot, 'store-vrm-aa-core.vrm')));
  assert.equal(sent[0]['X-Live-Key'], 'bnbl_x');
  assert.equal(sent[0]['If-None-Match'], undefined, 'no local copy, so no ETag sent');

  answer = { status: 304, headers: {} };
  r = await p.syncLive();
  assert.equal(r[0].status, 'unchanged');
  assert.equal(sent[1]['If-None-Match'], '"v1"');

  answer = { status: 200, headers: { etag: '"v2"' }, data: vrm('Core v2') };
  r = await p.syncLive();
  assert.equal(r[0].status, 'updated');
  assert.equal((await p.libraryItems()).length, 1, 'an update never adds a second copy');
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.vrmRoot, 'manifest.json'))).length, 1);

  answer = { status: 402, headers: {} };
  r = await p.syncLive();
  assert.equal(r[0].status, 'expired');
  assert.ok(fs.existsSync(path.join(p.vrmRoot, 'store-vrm-aa-core.vrm')));
  assert.equal((await p.livePasses())[0].state, 'expired');
});

test('the same bytes under a new ETag only save the ETag', async () => {
  const { p, store } = plugin();
  store.live = { passes: [{ slug: 'vrm-aa-core', key: encrypt('bnbl_x') }] };
  const body = vrm('Core');
  p.fetchLive = async () => ({ status: 200, headers: { etag: '"a"' }, data: body });
  await p.syncLive();
  p.fetchLive = async () => ({ status: 200, headers: { etag: '"b"' }, data: body });
  const r = await p.syncLive();
  assert.equal(r[0].status, 'same');
  assert.equal((await p.livePasses())[0].etag, '"b"');
});

test('no passes = no store call on the timer', async () => {
  const { p } = plugin();
  let called = false;
  p.api = async () => { called = true; return []; };
  p.fetchLive = async () => { called = true; return { status: 304, headers: {} }; };
  await p.liveTick();
  assert.equal(called, false);
});

test('a pass bought with a download lands under its model', async () => {
  const { p } = plugin();
  p.fetchBytes = async () => ({ buffer: vrm('Core'), type: 'model/gltf-binary' });
  const item = await p.ingest({ order: { id: 'o1', token: 't' }, downloads: [{ url: 'https://s/d', filename: 'core.vrm' }], variant: 'vrm-aa-core-live30' });
  assert.equal(item.variant, 'vrm-aa-core');
  assert.equal(item.livePass, 'vrm-aa-core-live30');
  assert.equal(item.files.find(f => f.kind === 'vrm')?.modelId, 'store-vrm-aa-core');
});

test('live URLs lose their key, expiries become dates', () => {
  assert.equal(liveUrl('https://botsandborgs.com/api/live/x/vrm?key=bnbl_1', 'x'), 'https://botsandborgs.com/api/live/x/vrm');
  assert.equal(liveUrl(null, 'x'), 'https://botsandborgs.com/api/live/x/vrm');
  assert.equal(liveUrl('http://evil/x', 'x'), 'https://botsandborgs.com/api/live/x/vrm');
  assert.equal(liveExpiry(1797270951), '2026-12-14T17:55:51.000Z');
  assert.equal(liveExpiry('2026-12-14T00:00:00Z'), '2026-12-14T00:00:00.000Z');
  assert.equal(liveExpiry(null), null);
});

test('a pass saved with its key in the URL is cleaned on the next check, and the answer never shows the key', async () => {
  const { p, store } = plugin();
  store.live = { passes: [{ slug: 'vrm-aa-core', key: encrypt('bnbl_q'), expires: 1797270951, vrmUrl: 'https://botsandborgs.com/api/live/vrm-aa-core/vrm?key=bnbl_q' }] };
  let url;
  p.fetchLive = async (u) => { url = u; return { status: 304, headers: {} }; };
  const r = await p.liveCommand({});
  assert.equal(url, 'https://botsandborgs.com/api/live/vrm-aa-core/vrm');
  assert.ok(!JSON.stringify(store.live).includes('bnbl_q'));
  assert.ok(!JSON.stringify(r).includes('bnbl_q'));
  assert.match(r.result, /until 2026-12-14/);
});

test('"switch back to Racer Blue" is a bought model, not a light colour; lights stay lights', async () => {
  const { asksToUseStoreItem, storeModelNames } = await import('../../src/services/store/assetLibrary.js');
  const names = ['Racer Blue', 'Core'];
  for (const t of ['switch back to Racer Blue', 'wear Racer Blue', 'put on the Core model', 'go back to your Racer Blue', 'change to racer blue']) assert.equal(asksToUseStoreItem(t, names), true, t);
  for (const t of ['set the lights to blue', 'switch the lights back to blue', 'turn the bedroom lights blue', 'core temperature of the cpu']) assert.equal(asksToUseStoreItem(t, names), false, t);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{ id: 'nova', name: 'Nova' }, { id: 'store-vrm-racer-blue-bundle', name: 'Racer Blue', source: 'botsandborgs' }]));
  assert.deepEqual(storeModelNames(dir), ['Racer Blue']);
});

test('asking to switch models wears the named one, including a model kept by a live pass', async () => {
  const { p, store } = plugin();
  store.library = { items: [
    { variant: 'vrm-aa-core', title: 'Core — VRM Avatar', kind: 'vrm', livePass: 'vrm-aa-core-live30', files: [{ name: 'Core.vrm', kind: 'vrm', modelId: 'store-vrm-aa-core' }] },
    { variant: 'vrm-racer-blue-bundle', title: 'Racer Blue — VRM Avatar', kind: 'bundle', files: [{ name: 'Racer Blue.vrm', kind: 'vrm', modelId: 'store-vrm-racer-blue-bundle' }] }
  ] };
  const worn = [];
  p.useModel = async ({ item, wear }) => { worn.push({ item, wear, picked: (await p.pickOwned({ item, kind: 'vrm', kinds: ['vrm'] }))?.item.variant }); return { success: true, result: 'ok' }; };
  for (const [asked, item] of [['wear the Core model', 'Core'], ['switch to your Core avatar', 'Core'], ['switch back to Racer Blue', 'Racer Blue'], ['put on Racer Blue again', 'Racer Blue']]) {
    await p.useOwned({ item, _context: { originalInput: asked } });
  }
  assert.deepEqual(worn.map(w => [w.wear, w.picked]), [[true, 'vrm-aa-core'], [true, 'vrm-aa-core'], [true, 'vrm-racer-blue-bundle'], [true, 'vrm-racer-blue-bundle']]);
});

test('a pass for a model owned through its bundle keeps THAT model current (the one being worn)', async () => {
  const { p, store } = plugin();
  p.agent.agentModel.activeVRMModel = 'store-vrm-racer-blue-bundle';
  const dir = path.join(p.libraryRoot, 'vrm-racer-blue-bundle');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Racer Blue.vrm'), vrm('Racer Blue'));
  store.library = { items: [{ variant: 'vrm-racer-blue-bundle', title: 'Racer Blue', kind: 'bundle', files: [
    { name: 'Racer Blue.vrm', kind: 'vrm', modelId: 'store-vrm-racer-blue-bundle' }, { name: 'Racer Blue lol.png', kind: 'sticker' }] }] };
  p.fetchBytes = async () => ({ buffer: vrm('Racer Blue'), type: 'model/gltf-binary' });
  const item = await p.ingest({ order: { id: 'o2', token: 't' }, downloads: [{ url: 'https://s/d', filename: 'Racer Blue.vrm' }], variant: 'vrm-racer-blue-live30' });
  assert.equal(item.variant, 'vrm-racer-blue-bundle');
  assert.equal(item.livePass, 'vrm-racer-blue-live30');
  assert.equal((await p.libraryItems()).length, 1, 'no second copy');
  assert.ok(item.files.some(f => f.kind === 'sticker'), 'the bundle keeps its other files');

  store.live = { passes: [{ slug: 'vrm-racer-blue', variant: 'vrm-racer-blue-live30', key: encrypt('bnbl_r'), vrmUrl: 'https://s/api/live/vrm-racer-blue/vrm' }] };
  let pushed = null;
  p.replaceModelPush = null;
  p.fetchLive = async () => ({ status: 200, headers: { etag: '"n"' }, data: vrm('Racer Blue v2') });
  const r = await p.syncLive().catch(e => { throw e; });
  assert.equal(r[0].status, 'updated');
  assert.equal(r[0].model, 'store-vrm-racer-blue-bundle');
  assert.equal(r[0].worn, true);
  assert.equal((await p.libraryItems()).length, 1);
});

test('renewal is due in the grace week or 3 days ahead, never twice a day, and buys the same length again', async () => {
  const { p, store } = plugin();
  const now = Date.parse('2026-12-12T00:00:00Z');
  assert.equal(p.renewDue({ expires: '2026-12-14T17:55:51.000Z' }, now), true);
  assert.equal(p.renewDue({ expires: '2026-12-30T00:00:00.000Z' }, now), false);
  assert.equal(p.renewDue({ state: 'grace', expires: '2026-12-01T00:00:00.000Z' }, now), true);
  assert.equal(p.renewDue({ state: 'grace', renewTriedAt: '2026-12-11T12:00:00Z' }, now), false);
  store.live = { passes: [{ slug: 'vrm-racer-blue', variant: 'vrm-racer-blue-live30', key: encrypt('bnbl_r'), expires: '2026-12-14T00:00:00.000Z' }] };
  const bought = [];
  p.buy = async (d) => { bought.push(d); return { success: true, result: 'Bought.' }; };
  p.refreshLivePasses = async () => [{ slug: 'vrm-racer-blue', expires: '2027-01-13T00:00:00.000Z' }];
  const r = await p.renewLive('vrm-racer-blue');
  assert.equal(bought[0].variant, 'vrm-racer-blue-live30');
  assert.equal(bought[0].use, 'install');
  assert.equal(r.expires, '2027-01-13T00:00:00.000Z');
  assert.match(r.result, /until 2027-01-13 \(was 2026-12-14\)/);
});

test('the live clip library: first listing is remembered, an ETag change fetches the packs again', async () => {
  const { p, store } = plugin();
  delete p.syncLiveClips;
  p.agent.agentModel.activeVRMModel = 'store-vrm-racer-blue-bundle'; // the pass checked is the worn body's (2119 #533)
  let listing = { packs: [{ variant: 'vrm-emote-animations-1', etag: '"a"' }, { variant: 'vrm-idle-pack', etag: '"b"' }] };
  p.fetchLive = async () => ({ status: 200, headers: {}, data: Buffer.from(JSON.stringify(listing)) });
  let updated = 0;
  p.updateOwned = async ({ kind }) => { assert.equal(kind, 'animation'); updated++; return [{ variant: 'vrm-idle-pack' }]; };
  const passes = [{ slug: 'vrm-racer-blue', key: encrypt('bnbl_r'), state: 'active' }];
  assert.equal(await p.syncLiveClips(passes), 'first');
  assert.equal(await p.syncLiveClips(passes), 'unchanged');
  listing = { packs: [{ variant: 'vrm-emote-animations-1', etag: '"a"' }, { variant: 'vrm-idle-pack', etag: '"c"' }] };
  assert.equal(await p.syncLiveClips(passes), 'updated');
  assert.equal(updated, 1);
  assert.equal(await p.syncLiveClips([{ slug: 'x', key: encrypt('k'), state: 'expired' }]), null);
});
