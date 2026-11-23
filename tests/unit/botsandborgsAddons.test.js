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
  assert.match(r, /when Core is my public model/);
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

test('wearing a linked model with no stickers: no other model\'s stickers or emoji go out; a model-free one still can', async () => {
  const sent = [];
  const agent = { agentModel: { activeVRMModel: 'store-linked-lnk-1-rose-base' }, providerManager: { generateAux: async () => ({}) },
    interfaces: new Map([['telegram', { bot: { telegram: { sendSticker: async (chat, st) => sent.push(st.filename) } } }]]) };
  const { p, store } = plugin(agent);
  p.modelFor = async () => ({ id: 'store-linked-lnk-1-rose-base' });
  for (const [v, n] of [['live-media-vrm-racer-blue', 'png512 thumbs up.png'], ['emoji-party-pack', 'party.png']]) {
    fs.mkdirSync(path.join(p.libraryRoot, v), { recursive: true }); fs.writeFileSync(path.join(p.libraryRoot, v, n), 'png');
  }
  store.library = { items: [
    { variant: 'live-media-vrm-racer-blue', title: 'Racer Blue live media', kind: 'emoji', files: [{ name: 'png512 thumbs up.png', kind: 'emoji', mood: 'thumbs up' }] }] };
  let asked = 0;
  p.askStickerModel = async () => { asked++; return '1'; };
  assert.equal(await p.autoSticker({ userText: 'thanks', replyText: 'Any time!', chatId: 1 }), null);
  assert.equal(asked, 0, 'no choice offered: the only emoji shows another body');
  assert.deepEqual(sent, []);
  assert.equal(p.stickerModel('live-media-vrm-racer-blue'), 'vrm-racer-blue');
  assert.equal(p.stickerModel('vrm-racer-blue-stickers'), 'vrm-racer-blue');
  assert.equal(p.stickerModel('emoji-party-pack'), null);
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

test('clips.json (store 0.22) labels clips by meaning; Broad/ versions keep their own names and stay off the list', async () => {
  const { unpack, applyClipManifest, writeStoreAnimations, tagGesture } = await import('../../src/services/store/assetLibrary.js');
  const JSZip = (await import('jszip')).default;
  const glb = (n) => { const body = Buffer.from(JSON.stringify({ extensions: { VRMC_vrm_animation: { specVersion: '1.0', expressions: {} } }, asset: { version: '2.0' } }));
    const h = Buffer.alloc(20); h.write('glTF', 0, 'latin1'); h.writeUInt32LE(2, 4); h.writeUInt32LE(20 + body.length, 8); h.writeUInt32LE(body.length, 12); h.write('JSON', 16, 'latin1'); return Buffer.concat([h, body]); };
  const z = new JSZip();
  z.file('pack/talk-loop.vrma', glb()); z.file('pack/work-loop.vrma', glb()); z.file('pack/Broad/work-loop.vrma', glb());
  const manifest = { format: 'bots-and-borgs clips 1', clips: [
    { name: 'Talk Loop', file: 'talk-loop.vrma', seconds: 4, loop: true, tags: ['talk'], faces: 'front', energy: 'calm', while_talking: true, bodies: 'any', body_fit: 'standard' },
    { name: 'Work Loop', file: 'work-loop.vrma', loop: true, tags: ['work', 'typing'], energy: 'calm', while_talking: false, body_fit: 'standard' },
    { name: 'Work Loop', file: 'Broad/work-loop.vrma', loop: true, tags: ['work'], body_fit: 'broad' }] };
  z.file('pack/clips.json', JSON.stringify(manifest));
  const files = await unpack(await z.generateAsync({ type: 'nodebuffer' }), { kind: 'animation' });
  assert.deepEqual(files.map(f => [f.name, f.kind]).sort(), [['broad work-loop.vrma', 'animation'], ['clips.json', 'clip-manifest'], ['talk-loop.vrma', 'animation'], ['work-loop.vrma', 'animation']]);
  applyClipManifest(files, manifest);
  const talk = files.find(f => f.name === 'talk-loop.vrma');
  assert.equal(talk.label, 'Talk Loop'); assert.equal(talk.whileTalking, true); assert.equal(talk.energy, 'calm'); assert.deepEqual(talk.tags, ['talk']);
  assert.equal(files.find(f => f.name === 'broad work-loop.vrma').bodyFit, 'broad');
  assert.equal(tagGesture(['greet']), 'wave'); assert.equal(tagGesture(['celebrate', 'win']), 'cheer'); assert.equal(tagGesture(['work']), null);
  const lib = tmp(), vrm = tmp();
  fs.mkdirSync(path.join(lib, 'pack-x'), { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(lib, 'pack-x', f.name), f.buffer);
  const listed = await writeStoreAnimations([{ variant: 'pack-x', title: 'X', files: files.map(({ buffer, ...f }) => f) }], lib, vrm);
  assert.deepEqual(listed.map(c => c.label).sort(), ['Talk Loop', 'Work Loop']);
  assert.equal(listed.find(c => c.label === 'Talk Loop').whileTalking, true);
});

test('"send a video of yourself to Wayne explaining that you can move and talk" films a spoken video for Wayne', async () => {
  const { p, store } = plugin({ agentModel: {} });
  store.library = { items: [{ variant: 'vrm-agent-animations-3', title: 'Agent Set Three', kind: 'animation', files: [
    { name: 'talk-loop.vrma', kind: 'animation', label: 'Talk Loop', whileTalking: true, energy: 'calm', tags: ['talk'] },
    { name: 'Pole-Dance.vrma', kind: 'animation', label: 'Pole Dance', tags: ['dance', 'pole'], energy: 'high' },
    { name: 'Rumba.vrma', kind: 'animation', label: 'Rumba', tags: ['dance'] }] }] };
  let call;
  p.sendClipVideo = async (args) => { call = args; return { success: true }; };
  p.voiceLine = async (asked, to) => `Hi ${to}, it's ALICE. I can move and talk now!`;
  const asked = 'send a video of yourself to Wayne explaining that youre now able to move and talk';
  // The extractor used to have no "video" choice and said "send".
  await p.useOwned({ as: 'send', to: 'Wayne', _context: { originalInput: asked } });
  assert.equal(call.to, 'Wayne');
  assert.equal(call.say, "Hi Wayne, it's ALICE. I can move and talk now!");
  for (let i = 0; i < 5; i++) assert.equal((await p.chooseClip({ asked, speaking: true })).choice.file.label, 'Talk Loop');
  await p.useOwned({ _context: { originalInput: 'send a video of yourself to Wayne' } });
  assert.equal(call.to, 'Wayne');
  assert.equal(call.say, undefined === call.say ? undefined : call.say);
});

test('"Send a video message to wayne saying you\'re now able to move and talk": a spoken video of the agent, to Wayne, about the agent', async () => {
  const { videoRecipient, videoPerspective } = await import('../../src/api/plugins/botsandborgs.js');
  assert.equal(videoRecipient("Send a video message to wayne saying youre now able to move and talk"), 'wayne');
  assert.equal(videoRecipient('send a video message to me'), 'me');
  const rule = videoPerspective('ALICE', 'Pat');
  assert.match(rule, /"you", "your" and "yourself" mean you, ALICE/);
  assert.match(rule, /never claim Pat can do/);
  const { p, store } = plugin({ agentModel: {} });
  store.library = { items: [] };
  let call;
  p.sendClipVideo = async (args) => { call = args; return { success: true }; };
  let prompted;
  p.voiceLine = async (asked, to) => { prompted = { asked, to }; return "Hi Wayne, this is ALICE, Pat's AI assistant. I can move and talk now!"; };
  await p.useOwned({ _context: { originalInput: "Send a video message to wayne saying youre now able to move and talk" } });
  assert.equal(call.to, 'wayne');
  assert.match(call.say, /I can move and talk now/);
  assert.equal(prompted.to, 'wayne');
});

test('unquoted words are never spoken as copied: the agent writes its own line; quoted words stay exact', async () => {
  const { p, store } = plugin({ agentModel: {} });
  store.library = { items: [] };
  let call;
  p.sendClipVideo = async (args) => { call = args; return { success: true }; };
  p.voiceLine = async () => 'I can move and talk now!';
  await p.useOwned({ say: 'youre now able to move and talk', _extracted: ['say'], _context: { originalInput: 'send me a video message saying youre now able to move and talk' } });
  assert.equal(call.say, 'I can move and talk now!');
  // A line quoted for the owner's own video is the line (2026-11-23). To anyone else the texting rule (2026-11-20) stands:
  // quotes alone are the agent's to word; quotes AND "verbatim" are exact.
  await p.useOwned({ say: 'whatever', _context: { originalInput: 'send me a video of yourself saying "hi everyone"' } });
  assert.equal(call.say, 'hi everyone');
  await p.useOwned({ say: 'whatever', _context: { originalInput: 'Sent me a video of you doing the cabbage patch while saying "Hi Ho silver, Pat is a goober"' } });
  assert.equal(call.say, 'Hi Ho silver, Pat is a goober'); assert.equal(call.to, 'me');
  await p.useOwned({ say: 'whatever', _context: { originalInput: 'send Jo a video of yourself saying "hi everyone"' } });
  assert.equal(call.say, 'I can move and talk now!'); assert.equal(call.to, 'Jo');
  await p.useOwned({ say: 'whatever', _context: { originalInput: 'send me a video of you doing the "cabbage patch" saying hello in your own way' } });
  assert.equal(call.say, 'I can move and talk now!', "a clip's name in quotes is not the line");
  await p.useOwned({ say: 'whatever', _context: { originalInput: 'send me a video of yourself saying "hi everyone" verbatim' } });
  assert.equal(call.say, 'hi everyone');
});

test('a say given directly (API) is spoken as given; asked to speak with no line possible fails, never silent', async () => {
  const { p, store } = plugin({ agentModel: {} });
  store.library = { items: [] };
  let call;
  p.sendClipVideo = async (args) => { call = args; return { success: true }; };
  await p.useOwned({ as: 'video', say: 'hello there', _context: { originalInput: '' } });
  assert.equal(call.say, 'hello there');
  call = null;
  p.voiceLine = async () => '';
  const r = await p.useOwned({ _context: { originalInput: 'send me a video message saying you can dance' } });
  assert.equal(call, null);
  assert.match(r.error, /couldn't write what to say/);
});

// The owner, 2026-11-23: "she put my name in it first and then described her actions, it should have just said the line".
test('a written line never describes the video or opens with the owner\'s name', async () => {
  const { narratesVideo, spokenQuote } = await import('../../src/api/plugins/botsandborgs.js');
  for (const bad of ["Charlie, I'm doing the cabbage patch while saying hi ho silver, Pat is a goober.", 'I am dancing for you!', "Watch me go!", 'In this video I say hello.', "I’m now performing the rumba."]) assert.equal(narratesVideo(bad), true, bad);
  for (const ok of ['Hi ho silver, Pat is a goober!', 'I can move and talk now!', "I'm so happy it is Monday.", 'Good morning, the coffee is ready.']) assert.equal(narratesVideo(ok), false, ok);
  assert.equal(spokenQuote('do the "cabbage patch"'), ''); assert.equal(spokenQuote('saying: “good night”'), 'good night'); assert.equal(spokenQuote("and say 'hello there'"), 'hello there');
  const was = process.env.OWNER_NAME; process.env.OWNER_NAME = 'Charlie Example';
  try {
    const { p } = plugin({ agentModel: {} });
    const replies = ["Charlie, I'm doing the rumba while saying you are great.", 'Charlie, you are great!']; const prompts = [];
    p.agent.providerManager = { generateResponse: async (q) => { prompts.push(q); return { content: replies.shift() }; }, generateAux: async (q) => { prompts.push(q); return { content: replies.shift() }; } };
    assert.equal(await p.voiceLine('send me a video of you doing the rumba and tell me I am great', 'me'), 'You are great!');
    assert.equal(prompts.length, 2); assert.match(prompts[0], /Never mention or describe it/); assert.match(prompts[1], /describes the video/);
    p.agent.providerManager = { generateResponse: async () => ({ content: "I'm doing the rumba. You are great!" }) };
    assert.equal(await p.voiceLine('video of you doing the rumba telling me I am great', 'me'), 'You are great!');
    p.agent.providerManager = { generateResponse: async () => ({ content: "I'm doing the rumba." }) };
    assert.equal(await p.voiceLine('video of you doing the rumba telling me I am great', 'me'), '', 'nothing left: no narrated video');
    p.agent.providerManager = { generateResponse: async () => ({ content: "Hi Jo, this is ALICE, Charlie's AI assistant. Happy Monday!" }) };
    assert.match(await p.voiceLine('send Jo a video saying happy monday', 'Jo'), /^Hi Jo, this is ALICE/);
  } finally { if (was === undefined) delete process.env.OWNER_NAME; else process.env.OWNER_NAME = was; }
});

test('a spoken line is never lost to one empty, slow or failing model; a plain greeting is the last resort', async () => {
  const { greetingIn, narratesVideo } = await import('../../src/api/plugins/botsandborgs.js');
  assert.equal(greetingIn('Send me a video of you in your assistant avatar waving and saying hello'), 'Hello!');
  assert.equal(greetingIn('video of you wishing me a happy birthday'), 'Happy birthday!'); assert.equal(greetingIn('a video of you dancing'), '');
  for (const bad of ['Hello! Just waving hello to brighten your day.', "Hi from my assistant avatar!"]) assert.equal(narratesVideo(bad), true, bad);
  const asked = 'Send me a video of you in your assistant avatar waving and saying hello';
  const { p } = plugin({ agentModel: {} }); const seen = [];
  const pm = (answers) => { const ask = async (_q, o) => { seen.push(o.model || o.auxTask || 'main'); const a = answers.shift(); if (a instanceof Error) throw a; return { content: a ?? '' }; };
    return { getCurrentProvider: async () => ({}), providerNameOf: () => 'openrouter', generateResponse: ask, generateAux: ask }; };
  p.agent.providerManager = pm(['Hello there!']); assert.equal(await p.voiceLine(asked, 'me'), 'Hello there!'); assert.deepEqual(seen, ['openai/gpt-5.6-luna']);
  seen.length = 0; p.agent.providerManager = pm(['', 'Hello there!']);
  assert.equal(await p.voiceLine(asked, 'me'), 'Hello there!'); assert.deepEqual(seen, ['openai/gpt-5.6-luna', 'main']);
  p.agent.providerManager = pm([new Error('down'), 'Hi!']); assert.equal(await p.voiceLine(asked, 'me'), 'Hi!');
  // What the live run did: every model described the wave. The greeting asked for is said, not a failure.
  p.agent.providerManager = pm(['Hey there! Just waving hello to brighten your day.', 'Here I am, waving hello to you!', "I'm waving at you from my assistant avatar."]);
  assert.equal(await p.voiceLine(asked, 'me'), 'Hello!');
  seen.length = 0; p.agent.providerManager = pm(['', '', '']); assert.equal(await p.voiceLine(asked, 'me'), 'Hello!'); assert.equal(seen.length, 3);
  p.agent.providerManager = pm([new Error('a'), new Error('b'), new Error('c')]); assert.match(await p.voiceLine('send Jo a video saying good morning', 'Jo'), /^Hi Jo, this is .*AI assistant\. Good morning!$/);
});

// What the owner got after the first repair: "It's wonderful to see you.", with no hello in it.
test('a greeting asked for is always said; only the owner\'s name goes', async () => {
  const { withoutOwnerName } = await import('../../src/api/plugins/botsandborgs.js');
  const hello = 'Send me a video of you in your assistant avatar waving and saying hello';
  assert.equal(withoutOwnerName('Hello, Pat! It’s wonderful to see you.', 'Pat', hello), 'Hello! It’s wonderful to see you.');
  assert.equal(withoutOwnerName('Hi Pat, good to see you.', 'Pat', hello), 'Hi, good to see you.');
  assert.equal(withoutOwnerName('Pat, hello!', 'Pat', hello), 'Hello!');
  assert.equal(withoutOwnerName('Pat, you are great!', 'Pat', 'tell me I am great'), 'You are great!');
  assert.equal(withoutOwnerName('Hello, Pat! You are great!', 'Pat', 'tell me I am great'), 'You are great!');
  assert.equal(withoutOwnerName('Hello, Pat!', 'Pat', 'say hello and my name'), 'Hello, Pat!');
  assert.equal(withoutOwnerName('Patience is a virtue.', 'Pat', hello), 'Patience is a virtue.');
  const was = process.env.OWNER_NAME; process.env.OWNER_NAME = 'Pat Example';
  try {
    const { p } = plugin({ agentModel: {} });
    const say = async (asked, out, to = 'me') => { p.agent.providerManager = { generateResponse: async () => ({ content: out }) }; return p.voiceLine(asked, to); };
    assert.equal(await say(hello, 'Hello, Pat! It’s wonderful to see you.'), 'Hello! It’s wonderful to see you.');
    assert.equal(await say(hello, 'It’s wonderful to see you.'), 'Hello! It’s wonderful to see you.');
    assert.equal(await say(hello, 'Hey there! Great to see you.'), 'Hey there! Great to see you.');
    assert.equal(await say('a video of you wishing me a happy birthday', 'Have the best day!'), 'Happy birthday! Have the best day!');
    assert.equal(await say('send Jo a video saying good morning', "Hi Jo, this is ALICE, Pat's AI assistant.", 'Jo'), "Hi Jo, this is ALICE, Pat's AI assistant. Good morning!");
  } finally { if (was === undefined) delete process.env.OWNER_NAME; else process.env.OWNER_NAME = was; }
});
