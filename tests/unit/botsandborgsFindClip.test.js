// The store's clip search (GET /api/animations): a move with no owned clip is answered with what to buy; it never buys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';

const heart = { name: 'Gesture Heart Hands', tags: ['heart', 'love'], pack: 'vrm-gesture-pack-3', pack_title: 'VRM Gesture Pack 3',
  pack_price_cents: 400, single: 'vrm-gesture-pack-3-heart-hands', single_price_cents: 50,
  buy: { variant: 'vrm-gesture-pack-3-heart-hands', or_pack: 'vrm-gesture-pack-3' } };
const wave = { name: 'Wave', tags: ['greet'], pack: 'vrm-emote-animations-1', pack_title: 'VRM Emotes', pack_price_cents: 300,
  single: null, buy: { variant: 'vrm-emote-animations-1' } };

function plugin({ clips = [], owned = [], files = [], fail = false } = {}) {
  const p = new BotsAndBorgsPlugin({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const calls = [];
  p.api = async (method, route) => { calls.push({ method, route }); if (fail) throw new Error('HTTP 500'); return { clips, total: clips.length }; };
  p.libraryItems = async () => owned.map(v => ({ variant: v, files }));
  return { p, calls };
}

test('findclip asks the store by meaning, standard fit, and marks what is owned', async () => {
  const { p, calls } = plugin({ clips: [heart, wave], owned: ['vrm-emote-animations-1'] });
  const r = await p.execute({ action: 'findclip', clip: 'heart hands!' });
  assert.equal(r.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].route, /^\/api\/animations\?q=heart%20hands&fit=standard&limit=5$/);
  assert.equal(r.clips[0].owned, false);
  assert.equal(r.clips[0].variant, 'vrm-gesture-pack-3-heart-hands');
  assert.equal(r.clips[1].owned, true, 'owned by its pack');
  assert.match(r.result, /Gesture Heart Hands: \$0\.50 on its own \(vrm-gesture-pack-3-heart-hands\) or \$4\.00 for VRM Gesture Pack 3/);
  assert.match(r.result, /Wave: I own it/);
});

test('a move with no owned clip quotes the store, and buys nothing', async () => {
  const clipFile = { kind: 'animation', name: 'wave.vrma', label: 'Wave' };
  const { p, calls } = plugin({ clips: [heart], owned: ['vrm-emote-animations-1'], files: [clipFile] });
  const r = await p.chooseClip({ clip: 'facepalm' });
  assert.match(r.error, /^I have no facepalm clip\. Mine: Wave\./);
  assert.match(r.error, /Bots & Borgs sells "Gesture Heart Hands": \$0\.50 on its own/);
  assert.ok(calls.every(c => c.method === 'GET'), 'no quote, no order');
});

test('the store failing or silent leaves the plain answer', async () => {
  const clipFile = { kind: 'animation', name: 'wave.vrma', label: 'Wave' };
  const { p } = plugin({ fail: true, owned: ['vrm-emote-animations-1'], files: [clipFile] });
  const r = await p.chooseClip({ clip: 'facepalm' });
  assert.equal(r.error, 'I have no facepalm clip. Mine: Wave.');
  const { p: p2 } = plugin({ clips: [], owned: ['vrm-emote-animations-1'], files: [clipFile] });
  assert.equal((await p2.chooseClip({ clip: 'facepalm' })).error, 'I have no facepalm clip. Mine: Wave.');
});

test('an owned match is never offered for sale', async () => {
  const clipFile = { kind: 'animation', name: 'wave.vrma', label: 'Wave' };
  const { p } = plugin({ clips: [{ ...heart }], owned: ['vrm-emote-animations-1', 'vrm-gesture-pack-3'], files: [clipFile] });
  assert.equal(await p.storeOffer('heart'), '');
});
