// The owner's evening on AvatarX, 2026-11-24, word for word as the voice passed it on: five turns for one Roger Rabbit,
// each cut by a salute after 3 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveRequest, secondsAsked } from '../../src/services/avatar/moveRequest.js';
import { autoEmote, _resetEmoteClock } from '../../src/services/avatar/autoEmote.js';
import { talkInstructions } from '../../src/services/voiceTalk.js';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

const labels = ['Roger Rabbit', 'Groove', 'Dance', 'Can Can', 'Booty Shake', 'Jump', 'Wave', 'Cupcake Wish', 'Running Man'];
const kind = (t, o = {}) => { const r = moveRequest(t, { labels, ...o }); return r && [r.kind, r.label, r.seconds].filter(x => x !== undefined).join(' '); };

test('every sentence of that evening is a Roger Rabbit', () => {
  for (const [t, want] of [
    ['They asked: can you do the Roger Rabbit? Please answer with what I can and can\'t do, and any related capability notes.', 'named Roger Rabbit'],
    ['The owner says I have an animation API from Bots & Borgs and can do the Roger Rabbit. What can I actually trigger, and how should I do it? Please provide the exact capabilities and any steps or command format if available.', 'named Roger Rabbit'],
    ['They want me to make my current avatar play the Roger Rabbit animation. Please provide the exact command or action to engage it, including any API call format, identifiers, or parameters, and any constraints. If I cannot directly execute it from here, state that clearly and provide the steps they should use.', 'named Roger Rabbit'],
    ['They want me to play the Roger Rabbit animation again on my current avatar. Please run it again and confirm status.', 'named Roger Rabbit'],
    ['They want the Roger Rabbit animation to loop for about 10 to 15 seconds because it’s short. Please loop it appropriately on my current avatar and confirm status and any constraints, like exact duration or loop count if relevant.', 'named Roger Rabbit 15'],
    ['do the roger rabbit', 'named Roger Rabbit'], ['Roger Rabbit!', 'named Roger Rabbit'], ['can-can please', 'named Can Can'], ['do a jump', 'named Jump'], ['do the groove for a minute', 'named Groove 60'],
    ['can you dance?', 'dance'], ['Dance for me', 'dance'], ['Show me some dances', 'dance'], ['they want me to dance', 'dance'], ["let's see you dance", 'dance'], ['what dances can you do?', 'list'], ['which moves do you have', 'list']
  ]) assert.equal(kind(t), want, t);
});

test('after a move: another, again, longer; with none before they are nothing', () => {
  const recent = { label: 'Groove' };
  assert.equal(kind('Try another', { recent }), 'another'); assert.equal(kind('do a different one', { recent }), 'another'); assert.equal(kind('again!', { recent }), 'again');
  assert.equal(kind('keep going', { recent }), 'again 30'); assert.equal(kind('do it again for 20 seconds', { recent }), 'again 20');
  assert.equal(kind('Try another'), null); assert.equal(kind('again'), null);
});

test('talk about dancing, another medium or another day is not a move', () => {
  for (const t of ['send Jo a video of you doing the roger rabbit', 'what is the history of the roger rabbit', 'I went to a dance and it was great', 'tell me a story about a dancing bear', 'remind me to do the running man tomorrow',
    'play some dance music', 'do you know the roger rabbit?', 'why did you stop dancing?', 'how much does the Can Can cost', 'what is the weather', 'I will jump in the shower', 'did you do the Roger Rabbit?', '', 'call mom and dance']) assert.equal(kind(t, { recent: { label: 'Groove' } }), null, t);
});

test('how long', () => {
  for (const [t, n] of [['for 10 to 15 seconds', 15], ['20s', 20], ['for half a minute', 30], ['2 minutes', 120], ['a minute', 60], ['10 minutes', 120], ['longer', 30], ['dance', null]]) assert.equal(secondsAsked(t), n, t);
});

function rig({ takes = true } = {}) {
  PluginSettings.getCached = async () => null; PluginSettings.setCached = async () => {};
  const p = new BotsAndBorgsPlugin({ interfaces: new Map(), agentModel: { activeVRMModel: 'store-vrm-racer-red' } });
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  p.vrmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'move-')); fs.mkdirSync(path.join(p.vrmRoot, 'animations'));
  const f = (name, label, x = {}) => ({ kind: 'animation', name, label, tags: [], gesture: 'dance', loop: true, seconds: 4.8, ...x });
  const files = [f('roger.vrma', 'Roger Rabbit'), f('groove.vrma', 'Groove', { seconds: 4 }), f('roger-in.vrma', 'Roger Rabbit In', { role: 'in' }), f('cup.vrma', 'Cupcake Wish', { gesture: null, loop: false, seconds: 6 })];
  fs.writeFileSync(path.join(p.vrmRoot, 'animations', 'store.json'), JSON.stringify(files.map(x => ({ file: `store/pack/${x.name}`, label: x.label, loop: x.loop, seconds: x.seconds }))));
  p.libraryItems = async () => [{ variant: 'pack', title: 'Pack', files }];
  p.wornBody = async () => 'female'; p.bodyOf = async () => 'female'; p.unsupportedProps = async () => new Map(); p.requiredProps = async () => new Map(); p.storeOffer = async () => ''; p.propsForBody = async () => []; p.clipsNotFor = async () => null;
  const pages = []; p.playOnPages = async (c) => { pages.push(c); return 1; };
  return { p, pages };
}

test('a dance goes on for about 15 s of whole passes, as long as was asked, and a move that does not loop plays once', async () => {
  const { p, pages } = rig();
  assert.equal(await p.moveByWords('They asked: can you do the Roger Rabbit? Please answer with what I can.'), 'Doing the Roger Rabbit.');
  assert.ok(Math.abs(pages[0].seconds - 19.2) < 0.01, 'four passes of 4.8 s'); assert.ok(p._move.until > Date.now() + 20000);
  await p.moveByWords('do the roger rabbit for 10 seconds'); assert.ok(Math.abs(pages[1].seconds - 14.4) < 0.01);
  await p.moveByWords('make a cupcake wish, do the cupcake wish'); assert.equal(pages[2].seconds, undefined);
  assert.match(await p.moveByWords('what dances can you do?'), /^I can do Roger Rabbit and Groove\. Which one\?$/);
  await p.moveByWords('do the groove'); for (let i = 0; i < 6; i++) { await p.moveByWords('try another'); assert.notEqual(pages.at(-1).label, pages.at(-2).label); }
  assert.equal(await p.moveByWords('what is the weather'), null);
  assert.match(await p.bodyBrief(), /Dances you can do: Roger Rabbit, Groove\. Other moves: Cupcake Wish\./);
  clearTimeout(p._moveTimer);
});

test('an AvatarX that plays a clip once gets it again at the end of each pass, until another move', async () => {
  const { p } = rig(); const played = [];
  p._move = { label: 'x' }; p.repeatOnAvatarX('roger', 0.02, 0.08, async (n) => { played.push(n); });
  await new Promise(r => setTimeout(r, 200)); assert.equal(played.length, 3, 'four passes in all');
  p._move = { label: 'y' }; p.repeatOnAvatarX('roger', 0.02, 10, async (n) => { played.push(n); }); p._move = { label: 'z' };
  await new Promise(r => setTimeout(r, 80)); assert.equal(played.length, 3);
});

test('no emote over a move, the face still follows; with none moving the emote plays', async () => {
  const sent = []; const call = async (m, r, b) => { if (m === 'GET') return { animations: ['emote-salute'], gestures: [], moods: ['neutral', 'happy'], mood: 'neutral' }; sent.push(JSON.parse(b)); };
  const go = (moving) => { _resetEmoteClock(); sent.length = 0; return autoEmote({ userText: 'dance', replyText: 'Doing it.', call, generate: async () => ({ content: '{"move":"emote-salute","face":"happy"}' }), moving: () => moving }); };
  await go(true); assert.deepEqual(sent, [{ mood: 'happy' }]);
  await go(false); assert.deepEqual(sent, [{ mood: 'happy' }, { name: 'emote-salute' }]);
});

test('"the Roger Rabbit." with a full stop, and an item instead of words, are the Roger Rabbit; a question is a yes', async () => {
  const { p } = rig();
  assert.equal((await p.chooseClip({ asked: 'and can do the Roger Rabbit. What next?' })).choice.file.label, 'Roger Rabbit');
  assert.equal((await p.chooseClip({ item: 'Roger Rabbit', asked: 'run it' })).choice.file.label, 'Roger Rabbit');
  p.findClips = async () => ['Roger Rabbit', 'Roger Rabbit In', 'Roger Rabbit Once'].map(name => ({ name, owned: true }));
  assert.match((await p.findClipCommand({ clip: 'Roger Rabbit' })).result, /^Yes, I can do the Roger Rabbit\./);
  assert.match(talkInstructions({ name: 'A', owner: 'Pat', surface: 'avatar', body: 'You are on screen.' }), /You are on screen\. When Pat asks for a dance/);
});

test('AvatarX gets a length it takes, and its answer is passed on', async () => {
  const { playOnAvatarX } = await import('../../src/services/avatar/avatarx.js');
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'axk-')), 'k'); fs.writeFileSync(keyFile, 'k');
  for (const [s, want] of [[124.8, 120], [0.2, 0.5], [19.2, 19.2], [null, undefined]]) {
    let sent, got; await playOnAvatarX('roger', { url: 'https://ax', keyFile, seconds: s, onAnswer: (r) => { got = r; }, fetchFn: async (u, o) => { sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ ok: true, seconds: sent.seconds }) }; } });
    assert.equal(sent.seconds, want); assert.equal(got.seconds, want);
  }
});

// Said by voice, 2026-11-24 22:34: "do the twerk dance" did a plain Dance.
test('"do the twerk dance" is Twerk 2; a described dance is found by meaning, one it lacks is said; plain dancing needs no model', async () => {
  assert.deepEqual(moveRequest('do the twerk dance', { labels: ['Dance', 'Twerk 2', 'Can Can'] }), { kind: 'named', label: 'Twerk 2' });
  assert.deepEqual(moveRequest('dab', { labels: ['Dab'] }), { kind: 'named', label: 'Dab' });
  const { p, pages } = rig(); const lib = await p.libraryItems();
  lib[0].files.push({ kind: 'animation', name: 'twerk-2.vrma', label: 'Twerk 2', tags: [], gesture: 'dance', loop: true, seconds: 16.2 }, { kind: 'animation', name: 'dance.vrma', label: 'Dance', tags: [], gesture: 'dance', loop: true, seconds: 4 });
  let asked = 0, answer = '0';
  p.agent.providerManager = { getCurrentProvider: async () => ({}), providerNameOf: () => 'openrouter', generateResponse: async () => { asked++; return { content: answer }; } };
  await p.moveByWords('do the twerk dance'); assert.equal(pages.at(-1).label, 'Twerk 2');
  for (const t of ['dance for me', 'can you dance?', "let's see you dance", 'show me some dances']) { await p.moveByWords(t); }
  assert.equal(asked, 0);
  answer = '2'; await p.moveByWords('do that dance where you sway your hips'); assert.equal(asked, 1); assert.equal(pages.at(-1).label, 'Groove');
  answer = '-1'; assert.match(await p.moveByWords('do the moonwalk dance'), /^I have no move for that yet/);
  assert.equal((await p.chooseClip({ asked: 'do the twerk', clip: null })).choice.file.label, 'Twerk 2');
});
