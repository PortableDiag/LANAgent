// Every product type on the store: what a download unpacks to, a model reaching the gallery, and using what is owned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';
import { variantKind, fileKind, unpack, readVrmInfo, installVrm, safeName, asksToUseStoreItem } from '../../src/services/store/assetLibrary.js';

function glb(json) {
  const body = Buffer.from(JSON.stringify(json));
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + body.length, 8);
  head.writeUInt32LE(body.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, body]);
}
const vrm1 = () => glb({ extensions: {
  VRMC_vrm: { meta: { name: 'Bear' }, humanoid: { humanBones: { hips: {}, head: {}, spine: {} } }, expressions: { preset: { happy: {}, sad: {} }, custom: { Smirk: {} } } },
  VRMC_springBone: { springs: [{}, {}] } } });
const png = () => sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
async function zipOf(files) {
  const z = new JSZip();
  for (const [n, b] of Object.entries(files)) z.file(n, b);
  return z.generateAsync({ type: 'nodebuffer' });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-'));

test('variant kinds match the real catalog', () => {
  const cases = { 'vrm-mm-bear': 'vrm', 'vrm-mm-bear-portraits': 'portrait', 'vrm-mm-bear-stickers': 'sticker', 'vrm-mm-bear-bundle': 'bundle',
    'bot-emoji-minis-happy': 'emoji', 'bot-emoji': 'emoji', 'deep-space-phone-pairs-cockpit-warp': 'wallpaper', 'agent-mode-wallpapers': 'wallpaper',
    'agent-avatar-icons-x': 'icon', 'crew-avatars-singles-flight-navy-blue': 'portrait', 'crew-avatars': 'portrait' };
  for (const [id, kind] of Object.entries(cases)) assert.equal(variantKind(id), kind, id);
});

test('files are classified by name, then by what was bought', () => {
  assert.equal(fileKind('Bear/bear.vrm'), 'vrm');
  assert.equal(fileKind('README.txt'), 'document');
  assert.equal(fileKind('Bear sticker 3.png', 'bundle'), 'sticker');
  assert.equal(fileKind('Bear portrait 1.png', 'bundle'), 'portrait');
  assert.equal(fileKind('preview.jpg', 'vrm'), 'preview');
  assert.equal(fileKind('happy-1.png', 'emoji'), 'emoji');
  assert.equal(fileKind('x.exe', 'emoji'), null);
});

test('a zip cannot write outside its folder, and junk is skipped', async () => {
  const z = new JSZip();
  z.file('../../evil.png', await png()); z.file('__MACOSX/._x.png', 'x'); z.file('run.sh', 'x'); z.file('a/same.png', 'x'); z.file('b/same.png', 'x');
  const files = await unpack(await z.generateAsync({ type: 'nodebuffer' }), { kind: 'portrait' });
  assert.deepEqual(files.map(f => f.name).sort(), ['evil.png', 'same 2.png', 'same.png']);
  assert.equal(safeName('../../../etc/passwd'), 'passwd');
  assert.equal(safeName('..'), 'file');
});

test('VRM facts come from the file; a non-VRM is refused', () => {
  const i = readVrmInfo(vrm1());
  assert.deepEqual({ v: i.vrmVersion, b: i.boneCount, s: i.springBoneCount, t: i.title }, { v: '1.0', b: 3, s: 2, t: 'Bear' });
  assert.deepEqual(i.expressions, ['Smirk', 'happy', 'sad']);
  assert.equal(readVrmInfo(glb({ extensions: { VRM: { meta: { title: 'Old' }, humanoid: { humanBones: [{}, {}] } } } })).vrmVersion, '0.x');
  assert.throws(() => readVrmInfo(glb({ asset: {} })), /no VRM data/);
  assert.throws(() => readVrmInfo(Buffer.from('this is not a model at all')), /not a glTF/);
});

test('installing keeps the gallery: other models stay, a repeat updates one entry, a broken manifest is left alone', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{ id: 'nova', file: 'nova.vrm' }]));
  const e = await installVrm(vrm1(), { variant: 'vrm-mm-bear', name: 'Bear' }, dir);
  await installVrm(vrm1(), { variant: 'vrm-mm-bear', name: 'Bear' }, dir);
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
  assert.deepEqual(list.map(m => m.id), ['nova', 'store-vrm-mm-bear']);
  assert.ok(fs.existsSync(path.join(dir, e.file)));
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{ broken');
  await assert.rejects(() => installVrm(vrm1(), { variant: 'x' }, dir), /can't be read/);
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), '{ broken');
});

function rig({ download, variantPrice = 1500, vrm = 'nova', slug = 'vrm-mm-bear' } = {}) {
  const store = { settings: { weeklyBudgetUsd: 50 }, ledger: { purchases: [] } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const told = []; const stickers = []; const sent = []; const texts = [];
  const agent = {
    config: { name: 'DELTA' }, agentModel: { activeVRMModel: vrm },
    interfaces: new Map([['telegram', { authorizedUserId: 1, sendNotification: async (t, o) => told.push({ t, o }), bot: { telegram: { sendSticker: async (u, f) => stickers.push(f) } } }]]),
    apiManager: { apis: new Map([['textx', { instance: { execute: async (a) => { texts.push(a); return { success: true }; } } }]]) },
    providerManager: {
      analyzeImage: async () => ({ analysis: 'very happy' }),
      generateResponse: async () => ({ content: '1' })
    }
  };
  const p = new BotsAndBorgsPlugin(agent);
  p.libraryRoot = tmp(); p.vrmRoot = tmp();
  fs.writeFileSync(path.join(p.vrmRoot, 'manifest.json'), JSON.stringify([{ id: 'nova', file: 'nova.vrm' }]));
  const product = { slug, title: 'Bear — VRM Avatar', collection: '3d-avatars', variants: [{ id: slug, label: 'VRM avatar', price_cents: 1200 }, { id: `${slug}-stickers`, label: 'Sticker set (12)', price_cents: 300 }, { id: `${slug}-bundle`, label: 'Complete bundle', price_cents: 1500 }] };
  p.api = async (m, route) => {
    if (route.startsWith('/api/catalog')) return { products: [product] };
    if (route === '/api/quotes') return { quote: { id: 'q1', total_cents: variantPrice } };
    if (route === '/api/crypto') return { assets: [{ symbol: 'USDT', token_address: 'T', decimals: 18, stable: true }] };
    if (route === '/api/orders') return { order: { id: 'o1' }, token: 't1', crypto: { address: '0xshop', amount: '15' } };
    if (route.startsWith('/api/orders/o1/crypto')) return { order: { id: 'o1', status: 'paid' }, downloads: [{ url: 'https://x/dl.zip' }] };
    throw new Error(`unexpected ${route}`);
  };
  p.accountKey = async () => 'k';
  p.walletUsd = async () => ({ amount: 1000, usd: 1000, address: '0xme' });
  p.tx = async () => ({ sendToken: async (...a) => { sent.push(a); return { hash: '0xtx' }; } });
  p.fetchBytes = async () => ({ buffer: download, type: 'application/zip' });
  return { p, store, told, stickers, sent, texts, agent };
}

test('buying a bundle: model in the gallery, stickers and portraits in the library, avatar and active model untouched', async () => {
  const download = await zipOf({ 'Bear/bear.vrm': vrm1(), 'Bear/README.txt': 'licence', 'Bear/preview.png': await png(), 'Bear sticker 1.png': await png(), 'Bear sticker 2.png': await png(), 'Bear portrait 1.png': await png() });
  const { p, store, agent, sent } = rig({ download });
  const r = await p.execute({ action: 'buy', variant: 'vrm-mm-bear-bundle' });
  assert.equal(r.success, true, r.error);
  assert.equal(sent.length, 1);
  assert.match(r.result, /Bear is in my model gallery/);
  const gallery = JSON.parse(fs.readFileSync(path.join(p.vrmRoot, 'manifest.json')));
  assert.deepEqual(gallery.map(m => m.id), ['nova', 'store-vrm-mm-bear-bundle']);
  assert.equal(agent.agentModel.activeVRMModel, 'nova', 'bought is not worn');
  const item = store.library.items[0];
  assert.deepEqual(item.files.map(f => f.kind).sort(), ['document', 'portrait', 'preview', 'sticker', 'sticker', 'vrm']);
  assert.equal(item.files.find(f => f.kind === 'sticker').mood, 'very happy');
  assert.equal(store.ledger.purchases[0].used, true);
});

test('owned things are used for free: a real sticker to the owner, a text to someone else, a model worn only on request', async () => {
  const download = await zipOf({ 'bear.vrm': vrm1(), 'Bear sticker 1.png': await png() });
  const { p, stickers, texts, sent, agent } = rig({ download });
  await p.execute({ action: 'buy', variant: 'vrm-mm-bear-bundle' });
  const paid = sent.length;

  const a = await p.execute({ action: 'use', as: 'send', to: 'me', mood: 'happy', item: 'bear' });
  assert.equal(a.success, true, a.error);
  assert.equal(stickers.length, 1);
  const meta = await sharp(stickers[0].source).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(Math.max(meta.width, meta.height), 512);

  const b = await p.execute({ action: 'use', as: 'send', to: 'Sam', kind: 'sticker' });
  assert.equal(b.success, true, b.error);
  assert.equal(texts[0].to, 'Sam');
  assert.ok(texts.every(t => !/\.vrm$/.test(t._context.attachedFile.filename)));

  const { Agent } = await import('../../src/models/Agent.js');
  const realUpdate = Agent.updateOne;
  Agent.updateOne = async () => ({});
  const c = await p.execute({ action: 'use', as: 'wear', item: 'bear' }).finally(() => { Agent.updateOne = realUpdate; });
  assert.equal(c.success, true, c.error);
  assert.equal(agent.agentModel.activeVRMModel, 'store-vrm-mm-bear-bundle');
  assert.equal(sent.length, paid, 'no new payment');
});

test('a .vrm alone is never sent on, and something not owned is said plainly', async () => {
  const { p, texts } = rig({ download: await zipOf({ 'bear.vrm': vrm1() }) });
  const none = await p.execute({ action: 'use', as: 'send', to: 'Sam', item: 'bear' });
  assert.match(none.error, /don't own/);
  await p.execute({ action: 'buy', variant: 'vrm-mm-bear' });
  const r = await p.execute({ action: 'use', as: 'send', to: 'Sam', item: 'bear' });
  assert.equal(r.success, false);
  assert.equal(texts.length, 0);
  const bought = await p.execute({ action: 'library', kind: 'vrm' });
  assert.match(bought.result, /1 vrm/);
  assert.ok(!JSON.stringify(bought.items).includes('t1'), 'the order token stays private');
});

test('a manifest replaced by a deploy gets bought models back; the budget still governs', async () => {
  const { p } = rig({ download: await zipOf({ 'bear.vrm': vrm1() }) });
  await p.execute({ action: 'buy', variant: 'vrm-mm-bear' });
  fs.writeFileSync(path.join(p.vrmRoot, 'manifest.json'), JSON.stringify([{ id: 'nova', file: 'nova.vrm' }]));
  await p.execute({ action: 'library' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.vrmRoot, 'manifest.json'))).map(m => m.id), ['nova', 'store-vrm-mm-bear']);
  const low = rig({ download: await zipOf({ 'bear.vrm': vrm1() }) });
  await PluginSettings.setCached('botsandborgs', 'settings', { weeklyBudgetUsd: 10 });
  const r = await low.p.execute({ action: 'buy', variant: 'vrm-mm-bear' });
  assert.equal(r.success, false);
  assert.match(r.error, /this w/);
  assert.equal(low.sent.length, 0);
});

test('plain requests for owned things are recognised; ordinary texts are not', () => {
  for (const t of ['send me a happy sticker', 'text Sam a sad sticker', 'wear the bear 3D model', 'use the bear vrm', 'install the vrm you bought']) assert.equal(asksToUseStoreItem(t), true, t);
  for (const t of ['text Sam and tell him to check telegram', 'send me the report', 'text Jo the thumbs up emoji', 'buy a house']) assert.equal(asksToUseStoreItem(t), false, t);
});
