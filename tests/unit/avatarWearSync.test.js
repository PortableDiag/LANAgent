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
