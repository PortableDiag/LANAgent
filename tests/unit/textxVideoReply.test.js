// TextX 0.4.93 video replies (Trellis 2119 #459-#465).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextXHub, REPLY_MODES } from '../../src/services/textx/textxHub.js';
import { memoryStore } from '../../src/services/textx/textxStore.js';
import TextXPlugin from '../../src/api/plugins/textx.js';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
function hub(talkingVideo) {
  const agent = { config: { name: 'ALICE' }, apiManager: { apis: new Map([['botsandborgs', { instance: { talkingVideo } }]]) },
    ttsService: { generateSpeech: async () => ({ buffer: Buffer.from('mp3') }) } };
  const h = new TextXHub({ store: memoryStore(), agent, logger: quiet });
  h.encodeVoice = async () => Buffer.from('m4a');
  return h;
}

test('video is a reply mode', () => assert.ok(REPLY_MODES.includes('video')));

test('a video reply sends reply.mp4; the text goes too only when just part was spoken', async () => {
  let asked;
  const h = hub(async (text, opts) => { asked = opts; return { video: Buffer.from('mp4'), seconds: 6.2, cut: false }; });
  const r = await h.replyArgs({ id: 'd1' }, 't1', 'Sure, see you at six!', 'video', { auto: true }, { maxSeconds: 20 });
  assert.equal(r.mode, 'video');
  assert.equal(asked.maxSeconds, 20);
  assert.equal(r.args.text, '');
  assert.equal(r.args.attachments[0].name, 'reply.mp4');
  assert.equal(r.args.auto, true);
  assert.equal(TextXHub.howSent(r), ' by video');
  const long = hub(async () => ({ video: Buffer.from('mp4'), seconds: 20, cut: true }));
  assert.equal((await long.replyArgs({ id: 'd1' }, 't1', 'a long reply', 'video')).args.text, 'a long reply');
});

test('a video that cannot be made falls back to voice, then text', async () => {
  const h = hub(async () => { throw new Error("I'm not wearing a 3D model"); });
  const r = await h.replyArgs({ id: 'd1' }, 't1', 'hi', 'video');
  assert.equal(r.mode, 'voice');
  assert.equal(r.args.attachments[0].name, 'reply.m4a');
  assert.match(TextXHub.howSent(r), /by voice \(the video failed/);
  const none = new TextXHub({ store: memoryStore(), agent: { config: { name: 'A' } }, logger: quiet });
  const t = await none.replyArgs({ id: 'd1' }, 't1', 'hi', 'video');
  assert.equal(t.mode, 'text');
  assert.equal(t.args.text, 'hi');
});

test('the spoken part fits the time and is cut at a sentence', () => {
  const short = BotsAndBorgsPlugin.spokenPart('See you at six! https://x.y/z 😀', 20);
  assert.deepEqual(short, { spoken: 'See you at six!', cut: false });
  const long = BotsAndBorgsPlugin.spokenPart(Array.from({ length: 12 }, (_, i) => `This is sentence number ${i} of the reply.`).join(' '), 10);
  assert.equal(long.cut, true);
  assert.ok(long.spoken.endsWith('.'));
  assert.ok(long.spoken.split(' ').length <= 26);
});

test('"reply with video here" sets this agent\'s reply mode in the conversation', async () => {
  const p = Object.create(TextXPlugin.prototype);
  const calls = [];
  p.findThread = async () => ({ thread: { thread_id: 't3', title: 'Sam' } });
  p.call = async (tool, args) => { calls.push({ tool, args }); return { ok: true, result: {} }; };
  const r = await p.updateThread({ thread: 'Sam', _context: { originalInput: 'reply with video in my conversation with Sam' } });
  assert.deepEqual(calls[0], { tool: 'update_thread', args: { thread_id: 't3', reply_forms: ['video'] } });
  assert.match(r.result, /with a video of me speaking/);
  p.call = async () => ({ ok: false, error: { code: 'not_picked' } });
  assert.match((await p.updateThread({ thread: 'Sam', replyMode: 'voice' })).error, /Pick it for me in TextX/);
});

test('TextX 0.4.94 reply_forms: every ticked form in one send, voice before video, text kept when anything fails', async () => {
  const { formsOf, modeOfForms } = await import('../../src/services/textx/textxHub.js');
  assert.deepEqual(formsOf(['video', 'text', 'voice']), ['text', 'voice', 'video']);
  assert.deepEqual(formsOf(null, 'both'), ['text', 'voice']);
  assert.equal(modeOfForms(['text', 'voice']), 'both');
  const h = hub(async () => ({ video: Buffer.from('mp4'), seconds: 5, cut: false }));
  const all = await h.replyArgs({ id: 'd1' }, 't1', 'See you!', 'video', {}, { forms: ['text', 'voice', 'video'] });
  assert.equal(all.args.text, 'See you!');
  assert.deepEqual(all.args.attachments.map(a => a.name), ['reply.m4a', 'reply.mp4']);
  assert.deepEqual(all.forms, ['text', 'voice', 'video']);
  assert.equal(TextXHub.howSent(all), ' (text + voice + video)');
  const voiceOnly = await h.replyArgs({ id: 'd1' }, 't1', 'Hi', 'voice', {}, { forms: ['voice'] });
  assert.equal(voiceOnly.args.text, '');
  assert.deepEqual(voiceOnly.args.attachments.map(a => a.name), ['reply.m4a']);
  const broken = hub(async () => { throw new Error('no model'); });
  broken.agent.ttsService = null;
  const r = await broken.replyArgs({ id: 'd1' }, 't1', 'Hi', 'video', {}, { forms: ['video'] });
  assert.equal(r.args.text, 'Hi');
  assert.equal(r.args.attachments, undefined);
  assert.match(TextXHub.howSent(r), /the video failed: no model; the voice failed/);
  const event = new TextXHub({ store: memoryStore(), agent: { config: { name: 'A' } }, logger: quiet });
  assert.deepEqual(event.replyForms({ replyForms: ['text'] }, { reply_forms: ['voice', 'video'] }), ['voice', 'video']);
  assert.equal(event.replyForms({ replyForms: null, replyMode: 'voice' }, { reply_mode: 'voice' }), null);
  assert.equal(event.replyMode({ replyForms: ['text'] }, { reply_forms: ['text', 'voice'] }), 'both');
});

test('the owner sets any mix of forms for a conversation', async () => {
  const p = Object.create(TextXPlugin.prototype);
  const calls = [];
  p.findThread = async () => ({ thread: { thread_id: 't3', title: 'Sam' } });
  p.call = async (tool, args) => { calls.push(args); return { ok: true, result: {} }; };
  let r = await p.updateThread({ thread: 'Sam', _context: { originalInput: 'answer Sam with text and voice' } });
  assert.deepEqual(calls.pop().reply_forms, ['text', 'voice']);
  assert.match(r.result, /with text and a voice note/);
  await p.updateThread({ thread: 'Sam', _context: { originalInput: 'reply to Sam with all three' } });
  assert.deepEqual(calls.pop().reply_forms, ['text', 'voice', 'video']);
  await p.updateThread({ thread: 'Sam', replyForms: ['video', 'voice'] });
  assert.deepEqual(calls.pop().reply_forms, ['voice', 'video']);
  assert.match((await p.updateThread({ thread: 'Sam', replyMode: 'carrier pigeon' })).error, /any mix/);
});
