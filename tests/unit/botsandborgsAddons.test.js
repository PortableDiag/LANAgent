// Store 0.17 add-ons: profile kit (banners), voice pack (a Kokoro voice preset), Call Sounds; and the Kokoro worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';
import { variantKind, fileKind } from '../../src/services/store/assetLibrary.js';
import { kokoroLang, isKokoroVoice, kokoroWorker } from '../../src/services/kokoroTts.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-addon-'));

test('add-on variants are their own kinds, never a model to wear', () => {
  assert.equal(variantKind('vrm-racer-blue-kit'), 'kit');
  assert.equal(variantKind('vrm-racer-blue-voice'), 'voice');
  assert.equal(variantKind('vrm-racer-blue-2d'), 'portrait');
  assert.equal(variantKind('vrm-racer-blue-motion'), 'motion');
  assert.equal(variantKind('call-sounds-pack'), 'sound');
  assert.equal(variantKind('vrm-racer-blue'), 'vrm');
});

test('the real downloads sort as they should (file names from the 2026-11-14 orders)', () => {
  for (const f of ['avatar-1024.png', 'avatar-640.png', 'avatar-round-512.png']) assert.equal(fileKind(f, 'kit'), 'portrait', f);
  for (const f of ['x-header-1500x500.png', 'discord-960x540.png', 'twitch-1200x480.png', 'wide-1584x396.png', 'youtube-2560x1440.png']) assert.equal(fileKind(f, 'kit'), 'banner', f);
  assert.equal(fileKind('voice.json', 'voice'), 'voice');
  assert.equal(fileKind('greeting.mp3', 'voice'), 'voice-sample');
  assert.equal(fileKind('hold-night-shift.flac', 'sound'), 'sound');
  assert.equal(fileKind('phone-8khz/ringback-us.wav', 'sound'), 'sound');
  assert.equal(fileKind('README.txt', 'sound'), 'document');
  assert.equal(fileKind('other.json', 'sound'), null);
});

test('kokoro languages and voice ids', () => {
  assert.equal(kokoroLang('a'), 'en-us');
  assert.equal(kokoroLang('b'), 'en-gb');
  assert.equal(kokoroLang('', 'bf_emma'), 'en-gb');
  assert.equal(kokoroLang('en-us'), 'en-us');
  assert.equal(isKokoroVoice('af_nicole'), true);
  assert.equal(isKokoroVoice('nova'), false);
  assert.equal(isKokoroVoice('af_nicole; rm -rf'), false);
});

function plugin(agent) {
  const store = {};
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const p = new BotsAndBorgsPlugin(agent);
  p.libraryRoot = tmp(); p.vrmRoot = tmp();
  return { p, store };
}

test('a voice pack becomes a saved Kokoro preset and the current voice is left alone', async () => {
  const saved = [];
  const agent = { agentModel: { activeVRMModel: 'store-vrm-racer-blue-bundle' }, ttsService: { saveVoiceProfile: async (name, f) => { saved.push({ name, ...f }); return { name, ...f }; } } };
  const { p, store } = plugin(agent);
  const dir = path.join(p.libraryRoot, 'vrm-racer-blue-voice');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'voice.json'), JSON.stringify({ engine: 'kokoro-82m', voice: 'af_nicole', lang_code: 'a', speed: 1.0, character: 'Racer Blue' }));
  store.library = { items: [{ variant: 'vrm-racer-blue-voice', title: 'Racer Blue — VRM Avatar: Voice pack', kind: 'voice', files: [{ name: 'voice.json', kind: 'voice' }] }] };
  const r = await p.useOwned({ item: 'Racer Blue voice pack', _context: { originalInput: 'use your Racer Blue voice pack' } });
  assert.equal(r.success, true);
  assert.deepEqual(saved, [{ name: 'Racer Blue voice', provider: 'kokoro', model: 'kokoro-82m', voice: 'af_nicole', speed: 1, format: 'mp3', lang: 'en-us' }]);
  assert.match(r.result, /switch to the Racer Blue voice|not installed/);
});

test('a kit for a model it does not wear waits; product bases line up across variants', async () => {
  const { p } = plugin({ agentModel: { activeVRMModel: 'store-vrm-racer-blue-bundle' } });
  assert.equal(p.wornBase(), 'vrm-racer-blue');
  for (const v of ['vrm-racer-blue-kit', 'vrm-racer-blue-voice', 'vrm-racer-blue-live30', 'store-vrm-racer-blue-bundle']) assert.equal(p.productBase(v), 'vrm-racer-blue', v);
  const r = await p.kitBannerUse({ variant: 'vrm-aa-core-kit', title: 'Core — VRM Avatar: Profile kit', files: [] });
  assert.match(r, /when I wear Core/);
  assert.equal(await p.bannerForModel('vrm-aa-core'), '');
});

test('the Kokoro worker speaks over JSON lines and fails pending requests when it dies', async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter(); this.stderr = new EventEmitter();
      this.stdin = { write: (line) => { const req = JSON.parse(line); setImmediate(() => this.stdout.emit('data', JSON.stringify({ id: req.id, ok: true, wav_b64: Buffer.from('RIFF').toString('base64'), seconds: 1 }) + '\n')); }, end: () => {} };
      setImmediate(() => this.stdout.emit('data', '{"ready": true, "voices": ["af_nicole"]}\n'));
    }
    kill() { this.emit('close', 0); }
  }
  kokoroWorker.stop();
  kokoroWorker.spawnImpl = () => new FakeChild();
  const r = await kokoroWorker.speak({ text: 'hi', voice: 'af_nicole' });
  assert.equal(r.ok, true);
  assert.deepEqual(kokoroWorker.voices, ['af_nicole']);
  kokoroWorker.child.stdin.write = () => {};
  const pending = kokoroWorker.speak({ text: 'again', voice: 'af_nicole' });
  setImmediate(() => kokoroWorker.child.emit('close', 1));
  await assert.rejects(pending, /exited/);
  kokoroWorker.stop();
});

test('store 0.18.4 voice.json: `lang` wins, and with no local Kokoro the hosted OpenRouter model speaks it', async () => {
  const saved = [];
  const agent = { agentModel: {}, providerManager: { providers: new Map([['openrouter', {}]]) },
    ttsService: { saveVoiceProfile: async (name, f) => { saved.push({ name, ...f }); return { name, ...f }; } } };
  const { p } = plugin(agent);
  const dir = path.join(p.libraryRoot, 'vrm-x-voice');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'voice.json'), JSON.stringify({ engine: 'kokoro-82m', voice: 'bf_emma', lang_code: 'b', lang: 'en-gb', speed: 0.95, character: 'Emma',
    alternatives: { python313: 'kokoro-onnx (same voice names, lang=en-gb)', hosted: 'OpenRouter hexgrad/kokoro-82m' } }));
  const item = { variant: 'vrm-x-voice', title: 'Emma — VRM Avatar: Voice pack', kind: 'voice', files: [{ name: 'voice.json', kind: 'voice' }] };
  const v = await p.installVoicePack(item);
  const { kokoroAvailable } = await import('../../src/services/kokoroTts.js');
  if (kokoroAvailable()) assert.equal(saved[0].lang, 'en-gb');
  else assert.deepEqual(saved[0], { name: 'Emma voice', provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'bf_emma', speed: 0.95, format: 'mp3' });
  assert.equal(v.available, true);
});

test('motion pack: clips and video stickers keep apart, stickers get moods, backgrounds get their format from the size', async () => {
  const { unpack, moodOf } = await import('../../src/services/store/assetLibrary.js');
  const JSZip = (await import('jszip')).default;
  const z = new JSZip();
  z.file('Core motion/clips/Core think.webm', Buffer.from('a')); z.file('Core motion/clips/Core think.mp4', Buffer.from('b'));
  z.file('Core motion/telegram-stickers/Core think.webm', Buffer.from('c')); z.file('Core motion/README.txt', 'r');
  const files = await unpack(await z.generateAsync({ type: 'nodebuffer' }), { kind: 'motion' });
  const byName = Object.fromEntries(files.map(f => [f.name, f.kind]));
  assert.deepEqual(byName, { 'Core think.webm': 'clip', 'Core think.mp4': 'clip', 'sticker Core think.webm': 'video-sticker', 'README.txt': 'document' });
  assert.equal(moodOf('sticker Core think.webm', 'video-sticker'), 'think');
  const b = new JSZip();
  b.file('Studios/desktop 1920x1080/Music Room 1920x1080.jpg', Buffer.from('d')); b.file('Studios/phone 1080x1920/Music Room 1080x1920.jpg', Buffer.from('e'));
  const bg = await unpack(await b.generateAsync({ type: 'nodebuffer' }), { kind: 'background' });
  assert.deepEqual(bg.map(f => [f.name, f.kind, f.format]).sort(), [['desktop Music Room 1920x1080.jpg', 'background', 'desktop'], ['phone Music Room 1080x1920.jpg', 'background', 'phone']]);
});

test('only the worn model\'s video stickers go out unasked, and they win over still ones for a mood', async () => {
  const sent = [];
  const agent = { agentModel: { activeVRMModel: 'store-vrm-racer-blue-bundle' }, providerManager: { generateAux: async () => ({}) },
    interfaces: new Map([['telegram', { bot: { telegram: { sendSticker: async (chat, st) => sent.push(st.filename) } } }]]) };
  const { p, store } = plugin(agent);
  for (const [v, n] of [['vrm-racer-blue-motion', 'sticker Racer Blue lol.webm'], ['vrm-aa-core-motion', 'sticker Core lol.webm']]) {
    fs.mkdirSync(path.join(p.libraryRoot, v), { recursive: true }); fs.writeFileSync(path.join(p.libraryRoot, v, n), 'webm');
  }
  store.library = { items: [
    { variant: 'vrm-aa-core-motion', title: 'Core', kind: 'motion', files: [{ name: 'sticker Core lol.webm', kind: 'video-sticker', mood: 'lol' }] },
    { variant: 'vrm-racer-blue-motion', title: 'Racer Blue', kind: 'motion', files: [{ name: 'sticker Racer Blue lol.webm', kind: 'video-sticker', mood: 'lol' }] },
    { variant: 'vrm-racer-blue-bundle', title: 'Racer Blue', kind: 'bundle', files: [{ name: 'Racer Blue lol.png', kind: 'sticker', mood: 'lol' }] }] };
  p.askStickerModel = async () => '1';
  const mood = await p.autoSticker({ userText: 'haha', replyText: 'Ha, good one!', chatId: 1 });
  assert.equal(mood, 'lol');
  assert.deepEqual(sent, ['sticker.webm']);
});

test('a ready-made reaction clip is found for the worn model only; a background is picked by name', async () => {
  const { p, store } = plugin({ agentModel: { activeVRMModel: 'store-vrm-racer-blue-bundle' } });
  store.library = { items: [
    { variant: 'vrm-aa-core-motion', title: 'Core', kind: 'motion', files: [{ name: 'Core wave.mp4', kind: 'clip' }] },
    { variant: 'vrm-racer-blue-motion', title: 'Racer Blue — VRM Avatar: Motion pack', kind: 'motion', files: [{ name: 'Racer Blue wave.mp4', kind: 'clip' }, { name: 'Racer Blue wave.webm', kind: 'clip' }] },
    { variant: 'bg-studios-rooms-pack', title: 'Studios', kind: 'background', files: [
      { name: 'phone Music Room 1080x1920.jpg', kind: 'background', format: 'phone' }, { name: 'desktop Music Room 1920x1080.jpg', kind: 'background', format: 'desktop' },
      { name: 'phone Art Studio 1080x1920.jpg', kind: 'background', format: 'phone' }] }] };
  const r = await p.readyClip('send me a video of you waving');
  assert.equal(r.item.variant, 'vrm-racer-blue-motion');
  assert.equal(r.file.name, 'Racer Blue wave.mp4');
  assert.equal(await p.readyClip('send me a video of you doing the pole dance'), null);
  assert.match(await p.backgroundFor('film yourself waving in the music room'), /phone Music Room 1080x1920\.jpg$/);
  assert.match(await p.backgroundFor('send a video'), /phone (Music Room|Art Studio) 1080x1920\.jpg$/);
  const none = plugin({ agentModel: { activeVRMModel: 'store-vrm-aa-core' } });
  none.store.library = { items: [] };
  assert.equal(await none.p.readyClip('wave'), null);
  assert.equal(await none.p.backgroundFor(''), null);
});

test('"waving" means the wave clip', async () => {
  const { clipGesture } = await import('../../src/services/store/assetLibrary.js');
  for (const t of ['send me a video of you waving', 'waving in the music room', 'wave', 'waves hello', 'Wave']) assert.equal(clipGesture(t), 'wave', t);
  assert.equal(clipGesture('Wavelength'), null);
  assert.equal(clipGesture('Booty Shake'), 'dance');
});

test('store 0.20.1 video sticker names ("Core think sticker.webm") keep their mood and their own name', async () => {
  const { unpack, moodOf } = await import('../../src/services/store/assetLibrary.js');
  const JSZip = (await import('jszip')).default;
  const z = new JSZip();
  z.file('Core motion/clips/Core think.webm', Buffer.from('a')); z.file('Core motion/telegram-stickers/Core think sticker.webm', Buffer.from('c'));
  const files = await unpack(await z.generateAsync({ type: 'nodebuffer' }), { kind: 'motion' });
  assert.deepEqual(Object.fromEntries(files.map(f => [f.name, f.kind])), { 'Core think.webm': 'clip', 'Core think sticker.webm': 'video-sticker' });
  assert.equal(moodOf('Core think sticker.webm', 'video-sticker'), 'think');
  assert.equal(moodOf('sticker Core lol.webm', 'video-sticker'), 'lol');
  assert.equal(moodOf('Racer Blue lol.png', 'sticker'), 'lol');
});

test('Booty Shake is shown facing away unless asked to face the camera (owner 2026-11-15)', async () => {
  const { p, store } = plugin({ agentModel: {} });
  store.library = { items: [{ variant: 'vrm-dance-pack-2', title: 'Dance Pack 2', kind: 'animation', files: [
    { name: 'Booty-Shake.vrma', kind: 'animation', label: 'Booty Shake' }, { name: 'Booty-Shake-Facing-Away.vrma', kind: 'animation', label: 'Booty Shake Facing Away' },
    { name: 'Rumba.vrma', kind: 'animation', label: 'Rumba' }] }] };
  assert.equal((await p.chooseClip({ asked: 'do the booty shake' })).choice.file.label, 'Booty Shake Facing Away');
  assert.equal((await p.chooseClip({ asked: 'send me a video of you doing the booty shake' })).choice.file.label, 'Booty Shake Facing Away');
  assert.equal((await p.chooseClip({ asked: 'do the booty shake facing me' })).choice.file.label, 'Booty Shake');
  assert.equal((await p.chooseClip({ asked: 'do the rumba' })).choice.file.label, 'Rumba');
});
