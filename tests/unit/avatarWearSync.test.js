// DELTA 2026-11-06: it bought and wore Sentinel (a model sold alone: .vrm + preview, no portrait), its picture never
// changed, "re-apply the Sentinel avatar" asked "Who should I send it to?", and every sync re-sent the old picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-data-'));
process.env.DATA_PATH = DATA;
const { default: JSZip } = await import('jszip');
const { default: sharp } = await import('sharp');
const { default: BotsAndBorgsPlugin } = await import('../../src/api/plugins/botsandborgs.js');
const { PluginSettings } = await import('../../src/models/PluginSettings.js');
const { Agent } = await import('../../src/models/Agent.js');
const { syncAgentAvatar } = await import('../../src/services/avatar/applyAgentAvatar.js');
Agent.updateOne = async () => ({});

function glb(json) {
  const body = Buffer.from(JSON.stringify(json));
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + body.length, 8);
  head.writeUInt32LE(body.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, body]);
}
const vrm = () => glb({ extensions: { VRMC_vrm: { meta: { name: 'Sentinel' }, humanoid: { humanBones: { hips: {}, head: {} } } } } });
const pic = (r) => sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g: 10, b: 10 } } }).jpeg().toBuffer();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-'));
const agentDir = path.join(DATA, 'agent');
const red = async (file) => (await sharp(file).raw().toBuffer())[0];

async function rig() {
  const z = new JSZip();
  z.file('Sentinel.vrm', vrm()); z.file('Sentinel preview.jpg', await pic(250)); z.file('README.txt', 'licence');
  const download = await z.generateAsync({ type: 'nodebuffer' });
  const store = { settings: { weeklyBudgetUsd: 50 }, ledger: { purchases: [] } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const photos = [];
  const agent = { agentModel: { activeVRMModel: 'nova' }, interfaces: new Map([['telegram', { syncBotPhoto: async (f) => { photos.push(fs.readFileSync(f)); return { success: true }; } }]]) };
  const p = new BotsAndBorgsPlugin(agent);
  agent.apiManager = { apis: new Map([['botsandborgs', { instance: p }]]) };
  p.libraryRoot = tmp(); p.vrmRoot = tmp();
  fs.writeFileSync(path.join(p.vrmRoot, 'manifest.json'), JSON.stringify([{ id: 'nova', file: 'nova.vrm' }]));
  const slug = 'vrm-overseer-sentinel';
  const product = { slug, title: 'Sentinel — VRM Avatar', collection: '3d-avatars', variants: [{ id: slug, label: 'VRM avatar', price_cents: 1200 }] };
  p.api = async (m, route) => {
    if (route.startsWith('/api/catalog')) return { products: [product] };
    if (route === '/api/quotes') return { quote: { id: 'q1', total_cents: 1200 } };
    if (route === '/api/crypto') return { assets: [{ symbol: 'USDT', token_address: 'T', decimals: 18, stable: true }] };
    if (route === '/api/orders') return { order: { id: 'o1' }, token: 't1', crypto: { address: '0xshop', amount: '12' } };
    if (route.startsWith('/api/orders/o1/crypto')) return { order: { id: 'o1', status: 'paid' }, downloads: [{ url: 'https://x/dl.zip' }] };
    throw new Error(`unexpected ${route}`);
  };
  p.accountKey = async () => 'k';
  p.walletUsd = async () => ({ amount: 1000, usd: 1000, address: '0xme' });
  p.tx = async () => ({ sendToken: async () => ({ hash: '0xtx' }) });
  p.fetchBytes = async () => ({ buffer: download, type: 'application/zip' });
  return { p, agent, photos };
}

test('a model sold alone is worn with its preview as the avatar, on Telegram too', async () => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  const { p, agent, photos } = await rig();
  const r = await p.execute({ action: 'buy', variant: 'vrm-overseer-sentinel', use: 'avatar' });
  assert.equal(r.success, true, r.error);
  assert.equal(agent.agentModel.activeVRMModel, 'store-vrm-overseer-sentinel');
  assert.match(r.result, /its picture is my avatar/);
  assert.ok(await red(path.join(agentDir, 'avatar.png')) > 200, 'avatar.png is the preview');
  assert.equal(photos.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'avatar-source.json'))).variant, 'vrm-overseer-sentinel');
});

test('"re-apply/equip the Sentinel avatar" wears it instead of asking who to send it to', async () => {
  const { p, agent } = await rig();
  await p.execute({ action: 'buy', variant: 'vrm-overseer-sentinel' });
  agent.agentModel.activeVRMModel = 'nova';
  const r = await p.execute({ action: 'use', item: 'Sentinel', _context: { originalInput: 'Re-apply/equip the Sentinel avatar so it actually updates the Telegram profile avatar' } });
  assert.equal(r.success, true, r.error);
  assert.equal(agent.agentModel.activeVRMModel, 'store-vrm-overseer-sentinel');
  const s = await p.execute({ action: 'use', as: 'avatar', item: 'Sentinel' });
  assert.equal(s.success, true, s.error);
});

test('a sync from before the fix sends the worn model\'s picture, not the old one; a repeat changes nothing', async () => {
  const { p, agent, photos } = await rig();
  await p.execute({ action: 'buy', variant: 'vrm-overseer-sentinel' });
  // DELTA's state: wearing Sentinel, old picture, no record of where it came from.
  fs.writeFileSync(path.join(agentDir, 'avatar.png'), await sharp(await pic(5)).png().toBuffer());
  fs.rmSync(path.join(agentDir, 'avatar-source.json'));
  photos.length = 0;
  const a = await syncAgentAvatar(agent);
  assert.match(a.picture, /model I wear/);
  assert.ok(await red(path.join(agentDir, 'avatar.png')) > 200);
  assert.equal(photos.length, 1);
  const before = fs.readFileSync(path.join(agentDir, 'avatar.png'));
  await syncAgentAvatar(agent);
  assert.ok(fs.readFileSync(path.join(agentDir, 'avatar.png')).equals(before), 'same bytes, no re-encode');
});

test('a picture chosen after the model was worn is kept by a sync', async () => {
  const { p, agent } = await rig();
  await p.execute({ action: 'buy', variant: 'vrm-overseer-sentinel' });
  const { applyAgentAvatar } = await import('../../src/services/avatar/applyAgentAvatar.js');
  await applyAgentAvatar(agent, await pic(5), { source: 'the web UI', only: [] });
  const r = await syncAgentAvatar(agent);
  assert.equal(r.picture, 'my current picture');
  assert.ok(await red(path.join(agentDir, 'avatar.png')) < 30);
});

test('a wide preview sheet is cut to its first figure (the front view), squared on its own background', async () => {
  const { portraitFromPreview } = await import('../../src/services/store/assetLibrary.js');
  const box = (r, w, h) => ({ input: { create: { width: w, height: h, channels: 3, background: { r, g: 0, b: 0 } } } });
  const sheet = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: { r: 27, g: 27, b: 35 } } })
    .composite([{ ...box(250, 280, 620), left: 70, top: 220 }, { ...box(120, 260, 560), left: 470, top: 250 }, { ...box(60, 280, 600), left: 820, top: 230 }])
    .png().toBuffer();
  const out = await portraitFromPreview(sheet);
  const { width, height } = await sharp(out).metadata();
  assert.equal(width, height);
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const count = (r) => { let n = 0; for (let i = 0; i < data.length; i += info.channels) if (data[i] === r && data[i + 1] === 0) n++; return n; };
  assert.equal(count(250), 280 * 620, 'the whole front figure');
  assert.equal(count(120) + count(60), 0, 'none of the other views');
  const narrow = await pic(100);
  assert.equal(await portraitFromPreview(narrow), narrow, 'a square picture is left alone');
});

test('a sync while wearing a model rebuilds its picture from the model, and an identical result changes nothing', async () => {
  const { p, agent, photos } = await rig();
  await p.execute({ action: 'buy', variant: 'vrm-overseer-sentinel' });
  fs.writeFileSync(path.join(agentDir, 'avatar.png'), await sharp(await pic(5)).png().toBuffer()); // an older cut, recorded as this model
  const a = await syncAgentAvatar(agent);
  assert.match(a.picture, /model I wear/);
  assert.ok(await red(path.join(agentDir, 'avatar.png')) > 200);
  const history = () => fs.readdirSync(path.join(agentDir, 'avatar-history')).length;
  const kept = history();
  await syncAgentAvatar(agent);
  assert.equal(history(), kept, 'no new history entry: the picture did not change');
  assert.ok(photos.length >= 2);
});

test('"pick another avatar … get the pack and apply it" while wearing one: a new model, not owned, bundle, worn', async () => {
  const { p, agent, photos } = await rig();
  await p.execute({ action: 'buy', variant: 'vrm-overseer-sentinel' });
  assert.equal(agent.agentModel.activeVRMModel, 'store-vrm-overseer-sentinel');
  const z = new JSZip();
  z.file('Bear/bear.vrm', vrm()); z.file('Bear/Bear portrait 1.png', await sharp(await pic(180)).png().toBuffer()); z.file('Bear/Bear sticker 1.png', await pic(90));
  const bundle = await z.generateAsync({ type: 'nodebuffer' });
  const products = {
    'vrm-overseer-sentinel': { slug: 'vrm-overseer-sentinel', title: 'Sentinel — VRM Avatar', collection: '3d-avatars', variants: [{ id: 'vrm-overseer-sentinel' }, { id: 'vrm-overseer-sentinel-bundle' }], images: [{ url: 'https://x/s.jpg', caption: 'Sentinel' }] },
    'vrm-mm-bear': { slug: 'vrm-mm-bear', title: 'Bear — VRM Avatar', collection: '3d-avatars', variants: [{ id: 'vrm-mm-bear' }, { id: 'vrm-mm-bear-bundle' }], images: [{ url: 'https://x/b.jpg', caption: 'Bear' }] }
  };
  const quoted = [];
  const api = p.api;
  p.api = async (m, route, o) => {
    if (route === '/api/catalog') return { products: Object.values(products) };
    if (route.startsWith('/api/products/')) return { product: products[route.split('/').pop()] };
    if (route === '/api/quotes') { quoted.push(o.body.items[0].variant); return { quote: { id: 'q2', total_cents: 1500 } }; }
    return api(m, route, o);
  };
  const looked = [];
  agent.providerManager = { analyzeImage: async (_b, prompt) => { looked.push(prompt); return { analysis: '{"what":"a robot","score":8,"why":"fits me"}' }; } };
  p.fetchBytes = async (url) => (/x\/[sb]\.jpg/.test(url) ? { buffer: await pic(1), type: 'image/jpeg' } : { buffer: bundle, type: 'application/zip' });
  photos.length = 0;
  const r = await p.execute({ action: 'buy', _context: { originalInput: "Pick another avatar, Nexus already picked that one. Pick one that's fitting and get the pack and apply it." } });
  assert.equal(r.success, true, r.error);
  assert.deepEqual(quoted, ['vrm-mm-bear-bundle'], 'the bundle of a model it does not own');
  assert.equal(looked.length, 1, 'Sentinel, already owned, was not even looked at');
  assert.equal(agent.agentModel.activeVRMModel, 'store-vrm-mm-bear-bundle');
  assert.ok(Math.abs(await red(path.join(agentDir, 'avatar.png')) - 180) < 15, 'the bear portrait is the avatar');
  assert.equal(photos.length, 1, 'and Telegram got it');
});

test('a model another agent wears (P2P) or the request rules out is never picked', async () => {
  const { P2PPeer } = await import('../../src/models/P2PPeer.js');
  const real = { find: P2PPeer.find, online: P2PPeer.getOnlinePeers };
  P2PPeer.getOnlinePeers = async () => [];
  P2PPeer.find = () => ({ lean: async () => [{ displayName: 'ALICE', capabilities: [{ name: 'wears_store_model', description: 'vrm-racer-blue' }] }] });
  try {
    const { p, agent } = await rig();
    await p.execute({ action: 'buy', variant: 'vrm-overseer-sentinel' });
    const mk = (slug, title) => ({ slug, title, collection: '3d-avatars', variants: [{ id: slug }, { id: `${slug}-bundle` }], images: [{ url: `https://x/${slug}.jpg` }] });
    const products = { 'vrm-overseer-sentinel': mk('vrm-overseer-sentinel', 'Sentinel'), 'vrm-racer-blue': mk('vrm-racer-blue', 'Racer Blue'), 'vrm-nr-daemon': mk('vrm-nr-daemon', 'Daemon'), 'vrm-mm-fox': mk('vrm-mm-fox', 'Fox') };
    const api = p.api;
    p.api = async (m, route, o) => {
      if (route === '/api/catalog') return { products: Object.values(products) };
      if (route.startsWith('/api/products/')) return { product: products[route.split('/').pop()] };
      if (route === '/api/quotes') return { quote: { id: 'q3', total_cents: 1500 } };
      return api(m, route, o);
    };
    const looked = [];
    agent.providerManager = { analyzeImage: async (_b, prompt) => { looked.push(/"(.+?)"/.exec(prompt)[1]); return { analysis: '{"score":8,"why":"ok"}' }; } };
    p.fetchBytes = async () => ({ buffer: await pic(1), type: 'image/jpeg' });
    const r = await p.execute({ action: 'buy', avoid: 'daemon', dryRun: true, _context: { originalInput: 'pick another avatar, get the pack and apply it' } });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(looked, ['Fox'], 'Sentinel (owned), Racer Blue (ALICE wears it) and Daemon (ruled out) are not candidates');
    assert.equal(r.variant, 'vrm-mm-fox-bundle');
    assert.match(r.result, /vrm-racer-blue \(ALICE\)/);
    assert.equal(agent.agentModel.activeVRMModel, 'store-vrm-overseer-sentinel', 'a dry run changes nothing');
  } finally { P2PPeer.find = real.find; P2PPeer.getOnlinePeers = real.online; }
});

test('"apply the avatar you bought" with no name wears the newest model, never a random older one', async () => {
  const { p, agent } = await rig();
  await p.execute({ action: 'buy', variant: 'vrm-overseer-sentinel' });
  const lib = (await PluginSettings.getCached('botsandborgs', 'library')).items;
  // a second, newer model in the library (the store would have put it first)
  const newer = { ...lib[0], variant: 'vrm-pilot-white-bundle', title: 'Pilot White' };
  const dir = path.join(p.libraryRoot, 'vrm-pilot-white-bundle');
  fs.cpSync(path.join(p.libraryRoot, 'vrm-overseer-sentinel'), dir, { recursive: true });
  await PluginSettings.setCached('botsandborgs', 'library', { items: [newer, ...lib] });
  for (let i = 0; i < 8; i++) {
    agent.agentModel.activeVRMModel = 'nova';
    const r = await p.execute({ action: 'use', as: 'wear' });
    assert.equal(r.success, true, r.error);
    assert.equal(agent.agentModel.activeVRMModel, 'store-vrm-pilot-white-bundle');
  }
});

test('"the avatar you just bought" names no product: it means the newest one', async () => {
  const { isGenericItem } = await import('../../src/api/plugins/botsandborgs.js');
  for (const t of ['the avatar you just bought', 'your new model', 'it', 'the one you just got', 'latest avatar pack']) assert.equal(isGenericItem(t), true, t);
  for (const t of ['Sentinel', 'the pilot white model', 'racer blue']) assert.equal(isGenericItem(t), false, t);
  const { p, agent } = await rig();
  await p.execute({ action: 'buy', variant: 'vrm-overseer-sentinel' });
  agent.agentModel.activeVRMModel = 'nova';
  const r = await p.execute({ action: 'use', as: 'wear', item: 'the avatar you just bought' });
  assert.equal(r.success, true, r.error);
  assert.equal(agent.agentModel.activeVRMModel, 'store-vrm-overseer-sentinel');
});

test('the owner’s stated taste rules a candidate out', async () => {
  const { p, agent } = await rig();
  p.ownerTaste = async () => '- Prefers avatars that are not anime-style girls.';
  const mk = (slug, title) => ({ slug, title, collection: '3d-avatars', variants: [{ id: slug }], images: [{ url: `https://x/${slug}.jpg` }] });
  const products = { 'vrm-pilot-white': mk('vrm-pilot-white', 'Pilot White'), 'vrm-mm-fox': mk('vrm-mm-fox', 'Fox') };
  p.api = async (m, route) => {
    if (route === '/api/catalog') return { products: Object.values(products) };
    if (route.startsWith('/api/products/')) return { product: products[route.split('/').pop()] };
    throw new Error(route);
  };
  const prompts = [];
  agent.providerManager = { analyzeImage: async (_b, prompt) => {
    prompts.push(prompt);
    return { analysis: /Pilot White/.test(prompt) ? '{"what":"an anime girl","score":9,"against_owner":true}' : '{"what":"a fox robot","score":6,"against_owner":false}' };
  } };
  p.fetchBytes = async () => ({ buffer: await pic(1), type: 'image/jpeg' });
  const pick = await p.pickFavorite({ kind: 'vrm', forWhom: 'yourself' });
  assert.equal(pick.variant, 'vrm-mm-fox', 'the higher score was against the owner');
  assert.match(prompts[0], /not anime-style girls/);
});
