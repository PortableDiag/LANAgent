// Auto emotes: the 3D body moves with a reply, only with moves AvatarX holds (2026-11-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emotesHeld, chooseEmote, autoEmote, _resetEmoteClock } from '../../src/services/avatar/autoEmote.js';

const HELD = ['nod', 'shake_head', 'look_around', 'bnb-wave', 'bnb-cheer', 'laugh', 'rumba', 'pole-dance', 'roger-rabbit', 'emote-think', 'idle-relaxed'];

test('only conversational moves count, never dances or idle loops', () => {
    const names = emotesHeld(HELD).map(e => e.name);
    assert.deepEqual(names, ['nod', 'shake_head', 'look_around', 'bnb-wave', 'bnb-cheer', 'laugh', 'emote-think']);
  });

test('a bought clip wins over the built-in head move, and emote-shake is the head shake', () => {
  const e = emotesHeld(['nod', 'shake_head', 'emote-nod', 'emote-shake', 'emote-thumbs-up'].reverse());
  assert.deepEqual(e.map(x => [x.name, x.key]), [['emote-thumbs-up', 'thumbs-up'], ['emote-shake', 'shake_head'], ['emote-nod', 'nod']]);
});

test('the model answer is checked against what is held', async () => {
    const emotes = emotesHeld(HELD);
    const ok = await chooseEmote({ generate: async () => '{"move":"bnb-cheer","face":"happy"}', emotes, moods: ['neutral', 'happy'], userText: 'I got the job!', replyText: 'Congratulations!' });
    assert.deepEqual(ok, { emote: 'bnb-cheer', mood: 'happy' });
    const bad = await chooseEmote({ generate: async () => '{"move":"rumba","face":"ecstatic"}', emotes, moods: ['neutral', 'happy'], userText: 'x', replyText: 'y' });
    assert.deepEqual(bad, { emote: null, mood: null });
    const junk = await chooseEmote({ generate: async () => 'sure!', emotes, moods: ['neutral'], userText: 'x', replyText: 'y' });
    assert.deepEqual(junk, { emote: null, mood: null });
  });

test('a code reply gets no emote and no model call', async () => {
    let asked = 0;
    const r = await chooseEmote({ generate: async () => { asked++; return '{}'; }, emotes: emotesHeld(HELD), moods: ['neutral'], userText: 'x', replyText: '```js\nx\n```' });
    assert.deepEqual(r, { emote: null, mood: null });
    assert.equal(asked, 0);
  });

test('plays the move and sets the face on AvatarX, then waits before asking again', async () => {
    _resetEmoteClock();
    const calls = [];
    const call = async (method, route, body) => {
      calls.push([method, route, body]);
      return method === 'GET' ? { gestures: ['nod', 'shake_head'], animations: ['bnb-wave', 'rumba'], moods: ['neutral', 'happy', 'sad'], mood: 'neutral' } : {};
    };
    const generate = async () => '{"move":"bnb-wave","face":"happy"}';
    const r = await autoEmote({ userText: 'hi!', replyText: 'Hello there!', call, generate, now: 1e12 });
    assert.deepEqual(r, { emote: 'bnb-wave', mood: 'happy' });
    assert.deepEqual(calls.slice(1), [['PATCH', '/agent/v1/state', '{"mood":"happy"}'], ['POST', '/agent/v1/gesture', '{"name":"bnb-wave"}']]);
    assert.equal(await autoEmote({ userText: 'hi', replyText: 'Hi', call, generate, now: 1e12 + 1000 }), null);
  });

test('a model that hangs means no emote, not a late one', async () => {
    const r = chooseEmote({ generate: () => new Promise(() => {}), emotes: emotesHeld(HELD), moods: ['neutral'], userText: 'x', replyText: 'y', timeoutMs: 50 });
    await assert.rejects(r, /timed out/);
  });
