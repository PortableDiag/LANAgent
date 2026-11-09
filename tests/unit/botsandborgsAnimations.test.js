// Bought animation clips (.vrma): classified, listed for the designer and the playground, given to AvatarX, and played.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';
import { variantKind, fileKind, readVrmaInfo, clipGesture, clipLoops, clipLabel, writeStoreAnimations } from '../../src/services/store/assetLibrary.js';
import { avatarxClipName, pushClipsToAvatarX, playOnAvatarX } from '../../src/services/avatar/avatarx.js';

function glb(json) {
  const body = Buffer.from(JSON.stringify(json));
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + body.length, 8);
  head.writeUInt32LE(body.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, body]);
}
const vrma = (expr = {}) => glb({ nodes: [{ name: 'hips' }, { name: 'happy' }], extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: { hips: { node: 0 } } }, expressions: { preset: expr } } } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-anim-'));

test('the real animation slugs are clips, not models; their videos are previews', () => {
  for (const id of ['vrm-dance-pack-1', 'vrm-dance-pack-2', 'vrm-emote-animations-1']) assert.equal(variantKind(id), 'animation', id);
  assert.equal(variantKind('anything', 'animations'), 'animation');
  assert.equal(variantKind('vrm-mm-bear'), 'vrm', 'a model stays a model');
  assert.equal(variantKind('vrm-mm-bear-bundle'), 'bundle');
  assert.equal(fileKind('pack/wave.vrma', 'animation'), 'animation');
  assert.equal(fileKind('pack/previews/wave.mp4', 'animation'), 'preview');
  assert.equal(fileKind('pack/cover.png', 'animation'), 'preview');
  assert.equal(fileKind('README.md', 'animation'), 'document');
});

test('what a clip is for and whether it loops, from its name', () => {
  assert.equal(clipGesture('Wave'), 'wave');
  assert.equal(clipGesture('Laugh'), 'laugh');
  assert.equal(clipGesture('Dance groove'), 'dance');
  assert.equal(clipGesture('Roger rabbit'), 'dance');
  assert.equal(clipGesture('Booty shake facing away'), 'dance');
  assert.equal(clipGesture('Thinking'), null);
  assert.equal(clipLoops('Wave'), false);
  assert.equal(clipLoops('Bow'), false);
  assert.equal(clipLoops('Rumba'), true);
  assert.equal(clipLoops('Rumba', ['cheer']), false, 'a stated list wins');
  assert.equal(clipLabel('dance_groove-120bpm.vrma'), 'Dance groove 120bpm');
});

test('a clip file is read for its face tracks; anything else is refused', () => {
  assert.deepEqual(readVrmaInfo(vrma({ happy: { node: 1 } })).expressions, ['happy']);
  assert.throws(() => readVrmaInfo(glb({ asset: {} })), /no VRM animation/);
  assert.throws(() => readVrmaInfo(Buffer.from('nope')), /not a glTF/);
});

function rig(download) {
  const store = { settings: { weeklyBudgetUsd: 50 }, ledger: { purchases: [] } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const p = new BotsAndBorgsPlugin({ config: { name: 'DELTA' }, agentModel: {}, interfaces: new Map(), providerManager: {} });
  p.libraryRoot = tmp(); p.vrmRoot = tmp();
  p.productOf = async () => ({ title: 'VRM Emote Animations: Set One', collection: 'animations', variants: [{ id: 'vrm-emote-animations-1', label: 'Animation set' }] });
  p.fetchBytes = async () => ({ buffer: download, type: 'application/zip' });
  return { p, store };
}

test('a bought pack: clips in the library and in store.json, the repo list untouched, nothing that is not a clip listed', async () => {
  const z = new JSZip();
  z.file('emotes/wave.vrma', vrma({ happy: { node: 1 } }));
  z.file('emotes/dance_groove.vrma', vrma());
  z.file('emotes/broken.vrma', glb({ asset: {} }));
  z.file('emotes/previews/wave.mp4', Buffer.from('video'));
  z.file('README.md', 'licence');
  const { p, store } = rig(await z.generateAsync({ type: 'nodebuffer' }));
  fs.mkdirSync(path.join(p.vrmRoot, 'animations'), { recursive: true });
  fs.writeFileSync(path.join(p.vrmRoot, 'animations', 'animations.json'), '[{"file":"Angry.vrma"}]');
  const item = await p.ingest({ order: { id: 'o1', token: 't' }, downloads: [{ url: 'https://x/dl.zip' }], variant: 'vrm-emote-animations-1' });
  assert.equal(item.kind, 'animation');
  assert.deepEqual(item.files.map(f => f.kind).sort(), ['animation', 'animation', 'document', 'preview']);
  const listed = JSON.parse(fs.readFileSync(path.join(p.vrmRoot, 'animations', 'store.json')));
  assert.deepEqual(listed.map(c => [c.file, c.label, c.loop, c.gesture]), [
    ['store/vrm-emote-animations-1/wave.vrma', 'Wave', false, 'wave'],
    ['store/vrm-emote-animations-1/dance_groove.vrma', 'Dance groove', true, 'dance']
  ]);
  assert.deepEqual(listed[0].expressions, ['happy']);
  assert.equal(listed[0].group, 'Bots & Borgs: VRM Emote Animations: Set One');
  for (const c of listed) assert.ok(fs.existsSync(path.join(p.vrmRoot, 'animations', c.file)));
  assert.equal(fs.readFileSync(path.join(p.vrmRoot, 'animations', 'animations.json'), 'utf8'), '[{"file":"Angry.vrma"}]');
  // A lost store.json (a wiped folder) comes back from the library.
  fs.rmSync(path.join(p.vrmRoot, 'animations'), { recursive: true });
  await p.repairGallery();
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.vrmRoot, 'animations', 'store.json'))).length, 2);
  assert.ok(store.library.items[0].files.find(f => f.name === 'wave.vrma').gesture === 'wave');
});

test("the pack's README decides which clips loop, also for packs already owned", async () => {
  const z = new JSZip();
  z.file('GoGo-Modern.vrma', vrma());
  z.file('Booty-Shake.vrma', vrma());
  z.file('Dab.vrma', vrma());
  z.file('README.txt', 'VRM Dance Pack 1\n\n  GoGo-Modern.vrma               23 s loop  modern club go-go\n  Booty-Shake.vrma               10.7 s     a twerk: hip pops, then a rhythmic shake\n  Dab.vrma                       3.6 s      two bars of groove, then the dab\n');
  const { p, store } = rig(await z.generateAsync({ type: 'nodebuffer' }));
  p.productOf = async () => ({ title: 'VRM Dance Pack 1', collection: 'animations', variants: [{ id: 'vrm-dance-pack-1', label: 'Dance pack' }] });
  await p.ingest({ order: { id: 'o2', token: 't' }, downloads: [{ url: 'https://x/dl.zip' }], variant: 'vrm-dance-pack-1' });
  const loops = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(p.vrmRoot, 'animations', 'store.json'))).map(c => [c.label, c.loop]));
  assert.deepEqual(loops, { 'GoGo Modern': true, 'Booty Shake': false, Dab: false }, 'the name guess would have looped Booty Shake');
  assert.equal(store.library.items[0].files.find(f => f.name === 'Booty-Shake.vrma').loop, false, 'saved in the library');
});

test('the library is the source: rebuilding twice gives the same list, and a clip with no file is left out', async () => {
  const lib = tmp(), vrm = tmp();
  fs.mkdirSync(path.join(lib, 'pack'));
  fs.writeFileSync(path.join(lib, 'pack', 'rumba.vrma'), vrma());
  const items = [{ variant: 'pack', title: 'Pack', files: [{ name: 'rumba.vrma', kind: 'animation', size: vrma().length }, { name: 'gone.vrma', kind: 'animation', size: 5 }] }];
  const a = await writeStoreAnimations(items, lib, vrm);
  const b = await writeStoreAnimations(items, lib, vrm);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map(c => c.label), ['Rumba']);
});

function avatarx(state) {
  const dir = tmp();
  const keyFile = path.join(dir, 'key');
  fs.writeFileSync(keyFile, 'secret\n');
  const clip = path.join(dir, 'Wave.vrma');
  fs.writeFileSync(clip, vrma());
  const calls = [];
  const fetchFn = async (url, o) => {
    calls.push({ url, method: o.method, body: o.body });
    const json = o.method === 'GET' ? state : /animations/.test(url) ? { animation: decodeURIComponent(/name=([^&]+)/.exec(url)[1]) } : { ok: true };
    return { ok: true, status: 200, json: async () => json };
  };
  return { opts: { url: 'https://127.0.0.1:8795', keyFile, fetchFn }, calls, clip };
}

test('AvatarX gets each clip once, never over a built-in gesture, and plays it on request', async () => {
  assert.equal(avatarxClipName('store/x/Dance Groove.vrma'), 'dance_groove');
  assert.equal(await pushClipsToAvatarX([{ file: '/x.vrma' }], { url: '', keyFile: '' }), 'not connected');
  const { opts, calls, clip } = avatarx({ gestures: ['wave', 'nod'], animations: [] });
  assert.deepEqual(await pushClipsToAvatarX([{ file: clip }], opts), ['bnb-wave']);
  assert.match(calls[1].url, /\/agent\/v1\/animations\?name=bnb-wave$/);
  const again = avatarx({ gestures: ['wave'], animations: ['bnb-wave'] });
  await pushClipsToAvatarX([{ file: again.clip }], again.opts);
  assert.equal(again.calls.filter(c => c.method === 'POST').length, 0, 'already there: not uploaded again');
  assert.equal(await playOnAvatarX('bnb-wave', opts), 'played');
  assert.deepEqual(JSON.parse(calls.at(-1).body), { name: 'bnb-wave' });
});

test('"do the rumba": an owned clip by name, by purpose, or a plain no', async () => {
  const lib = tmp();
  fs.mkdirSync(path.join(lib, 'pack'));
  const store = { library: { items: [{ variant: 'pack', title: 'Dance Pack 2', kind: 'animation', files: [
    { name: 'rumba.vrma', kind: 'animation', label: 'Rumba', gesture: 'dance' }, { name: 'wave.vrma', kind: 'animation', label: 'Wave', gesture: 'wave' }] }] } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  const p = new BotsAndBorgsPlugin({ config: { name: 'ALICE' }, agentModel: {}, interfaces: new Map(), providerManager: {} });
  p.libraryRoot = lib; p.vrmRoot = tmp();
  const prev = process.env.AVATARX_URL; delete process.env.AVATARX_URL;
  try {
    const r = await p.execute({ action: 'use', _context: { originalInput: 'do the rumba you bought' } });
    assert.equal(r.success, true, r.error);
    assert.equal(r.clip, 'Rumba');
    assert.match(r.result, /isn't open anywhere: open the 3D playground/);
    // With a playground open, no AvatarX: the page gets the clip, with its loop and its prop.
    const sent = [];
    p.agent.interfaces.set('web', { playOnAvatarPages: async (c) => { sent.push(c); return c.stop ? 1 : 2; } });
    fs.mkdirSync(path.join(p.vrmRoot, 'animations'), { recursive: true });
    fs.writeFileSync(path.join(p.vrmRoot, 'animations', 'store.json'), JSON.stringify([{ file: 'store/pack/rumba.vrma', label: 'Rumba', loop: true, prop: { type: 'pole' } }]));
    // "pole dance" names both "Dance" and "Pole Dance": the longer, more specific one, every time.
    store.library.items[0].files.push({ name: 'Dance.vrma', kind: 'animation', label: 'Dance', gesture: 'dance' }, { name: 'Pole-Dance.vrma', kind: 'animation', label: 'Pole Dance', gesture: 'dance' });
    for (let i = 0; i < 8; i++) assert.equal((await p.execute({ action: 'use', _context: { originalInput: 'do the pole dance' } })).clip, 'Pole Dance');
    assert.equal((await p.execute({ action: 'use', _context: { originalInput: 'do the can-can' } })).success, false, 'no Can Can owned here');
    const onPage = await p.execute({ action: 'use', _context: { originalInput: 'do the rumba' } });
    assert.equal(onPage.result, 'Doing Rumba now, in my 3D playground (2 pages open).');
    assert.deepEqual(sent.at(-1), { file: 'store/pack/rumba.vrma', label: 'Rumba', loop: true, prop: { type: 'pole' } });
    const stop = await p.execute({ action: 'use', _context: { originalInput: 'stop dancing' } });
    assert.equal(stop.result, 'Stopped.');
    assert.deepEqual(sent.at(-1), { stop: true });
    assert.equal((await p.execute({ action: 'use', as: 'play', clip: 'wave' })).clip, 'Wave');
    const no = await p.execute({ action: 'use', as: 'play', clip: 'bow' });
    assert.equal(no.success, false);
    assert.match(no.error, /no bow clip.*Rumba, Wave/);
    store.library.items = [];
    assert.match((await p.execute({ action: 'use', as: 'play' })).error, /don't own any animations/);
  } finally { if (prev !== undefined) process.env.AVATARX_URL = prev; }
});

test('the pole dance is a clip with its pole, though its slug reads like a model', async () => {
  assert.equal(variantKind('vrm-pole-dance'), 'animation');
  const lib = tmp(), vrm = tmp();
  fs.mkdirSync(path.join(lib, 'vrm-pole-dance'));
  fs.writeFileSync(path.join(lib, 'vrm-pole-dance', 'PoleDance.vrma'), vrma());
  const [c] = await writeStoreAnimations([{ variant: 'vrm-pole-dance', title: 'VRM Pole Dance', files: [{ name: 'PoleDance.vrma', kind: 'animation', size: vrma().length, loop: true }] }], lib, vrm);
  assert.deepEqual(c.prop, { type: 'pole', x: -0.40, z: 0, radius: 0.0225, height: 3 });
  assert.equal(c.loop, true);
  assert.equal(c.gesture, 'dance');
});

test('"buy all the animations": each pack not owned, one order each, stopping at the first refusal', async () => {
  const store = { settings: { weeklyBudgetUsd: 50 }, ledger: { purchases: [] }, library: { items: [{ variant: 'vrm-emote-animations-1', files: [] }] } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const p = new BotsAndBorgsPlugin({ config: { name: 'ALICE' }, agentModel: {}, interfaces: new Map(), providerManager: {} });
  const products = ['vrm-emote-animations-1', 'vrm-dance-pack-1', 'vrm-pole-dance'].map(id => ({ slug: id, title: id, collection: 'animations', variants: [{ id, price_cents: 400 }] }));
  p.api = async (m, route) => { if (route.startsWith('/api/catalog')) return { products }; throw new Error(route); };
  const asked = [];
  const real = p.buy.bind(p);
  p.buy = async (d) => (d.variant ? (asked.push([d.variant, d.use]), { success: true, result: 'ok' }) : real(d));
  const r = await p.execute({ action: 'buy', _context: { originalInput: 'buy all the animations from bots and borgs' } });
  assert.equal(r.success, true, r.error);
  assert.deepEqual(asked, [['vrm-dance-pack-1', 'keep'], ['vrm-pole-dance', 'keep']], 'the owned pack is skipped');
  assert.match(r.result, /Bought 2 animation packs \(\$8\.00\)/);
  p.buy = async (d) => (d.variant ? (d.variant === 'vrm-pole-dance' ? { success: false, error: 'over budget' } : { success: true, result: 'ok' }) : real(d));
  const stop = await p.execute({ action: 'buy', all: true, kind: 'animation' });
  assert.match(stop.result, /Bought vrm-dance-pack-1\. Stopped at vrm-pole-dance: over budget/);
});

test('owned items are fetched again: new and fixed files arrive, the item keeps its place and date', async () => {
  const z = new JSZip();
  z.file('Bear sticker 1.png', Buffer.from('new-art-1'));
  z.file('Bear sticker 13.png', Buffer.from('added'));
  const { p, store } = rig(await z.generateAsync({ type: 'nodebuffer' }));
  p.productOf = async () => ({ title: 'Bear', collection: '3d-avatars', variants: [{ id: 'vrm-mm-bear-stickers', label: 'Sticker set (12)' }] });
  store.library = { items: [
    { variant: 'newest-thing', kind: 'emoji', files: [] },
    { variant: 'vrm-mm-bear-stickers', kind: 'sticker', order: 'o9', token: 't9', at: '2026-11-05T00:00:00.000Z', files: [{ name: 'Bear sticker 1.png', kind: 'sticker', size: 3 }, { name: 'Bear sticker 2.png', kind: 'sticker', size: 3 }] }] };
  const routes = [];
  p.accountKey = async () => 'k';
  p.api = async (m, route) => { routes.push(route); return { downloads: [{ url: 'https://x/dl.zip' }] }; };
  const r = await p.execute({ action: 'library', update: true });
  assert.equal(r.success, true, r.error);
  assert.deepEqual(routes, ['/api/orders/o9?token=t9'], 'an item with no order is left alone');
  assert.deepEqual(r.updated, [{ variant: 'vrm-mm-bear-stickers', added: ['Bear sticker 13.png'], removed: ['Bear sticker 2.png'], changed: ['Bear sticker 1.png'] }]);
  assert.deepEqual(store.library.items.map(i => i.variant), ['newest-thing', 'vrm-mm-bear-stickers'], 'kept its place');
  assert.equal(store.library.items[1].at, '2026-11-05T00:00:00.000Z');
  assert.match(r.result, /vrm-mm-bear-stickers: 1 new, 1 gone, 1 changed/);
});

test('asking to buy clips reads as clips', () => {
  const p = new BotsAndBorgsPlugin({});
  assert.equal(p.kindAsked('buy the pole dance'), 'animation');
  assert.equal(p.kindAsked('buy the dance pack'), 'animation');
  assert.equal(p.kindAsked('buy yourself some emote animations'), 'animation');
  assert.equal(p.kindAsked('buy the bear bundle'), 'bundle');
  assert.equal(p.kindAsked('send me a sticker'), 'sticker');
});
