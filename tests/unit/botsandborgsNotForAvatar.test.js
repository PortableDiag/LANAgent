// Store 0.69: a pass's clip list may name clips its avatar must not play ("this avatar is not made to dance"). They are
// refused from any pack, the library included, on that body only, with the store's reason and never an offer to buy one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt } from '../../src/utils/encryption.js';
import BotsAndBorgsPlugin, { notForAvatar, clipStem } from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

const reason = 'this avatar is not made to dance';
const answer = { packs: [{ pack: 'vrm-idle-pack', etag: '"a"' }], not_for_this_avatar: { reason, clips: ['Roger-Rabbit', 'roger-rabbit-in', 'rumba', 'dance-bounce'], packs: ['vrm-dance-pack-2'], how: 'not from any pack you hold' } };

function rig(active = 'store-vrm-mm-shark-live30') {
  const store = {};
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const p = new BotsAndBorgsPlugin({ interfaces: new Map(), agentModel: { activeVRMModel: active } });
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const f = (name, label, tags, gesture) => ({ kind: 'animation', name, label, tags, gesture });
  p.libraryItems = async () => [
    { variant: 'vrm-dance-pack-2', title: 'Dance Pack 2', files: [f('Roger-Rabbit.vrma', 'Roger Rabbit', ['dance'], 'dance'), f('Rumba.vrma', 'Rumba', ['dance'], 'dance')] },
    { variant: 'vrm-emote-animations-1', title: 'Emotes', files: [f('emote-wave.vrma', 'Wave', ['greet'], 'wave'), f('Dance-Bounce.vrma', 'Dance Bounce', ['dance'], 'dance')] }];
  p.wornBody = async () => 'other'; p.bodyOf = async () => 'other';
  p.unsupportedProps = async () => new Map();
  p.syncLiveProps = async () => null;
  let offers = 0; p.storeOffer = async () => { offers++; return 'Bots & Borgs sells one.'; };
  return { p, store, offers: () => offers };
}

test('the answer is read by clip stem; no field, or an odd one, names nothing', () => {
  assert.equal(clipStem('store/vrm-dance-pack-2/Roger Rabbit.vrma'), 'roger-rabbit');
  assert.equal(clipStem('broad Roger_Rabbit.vrma'), 'roger-rabbit');
  assert.deepEqual(notForAvatar(answer), { reason, clips: ['roger-rabbit', 'roger-rabbit-in', 'rumba', 'dance-bounce'] });
  for (const x of [null, [], {}, { not_for_this_avatar: null }, { not_for_this_avatar: { clips: [] } }, { not_for_this_avatar: { clips: 'x' } }]) assert.equal(notForAvatar(x), null);
});

test('a named dance, "dance for me" and a dance it does not own are refused with the reason; other moves play', async () => {
  const { p, store, offers } = rig();
  store.notForAvatar = { 'vrm-mm-shark': notForAvatar(answer) };
  for (const q of [{ asked: 'do the roger rabbit' }, { clip: 'Roger Rabbit' }, { asked: 'dance for me' }, { clip: 'rumba' }, { asked: 'send me a video of you doing the dance bounce' }]) {
    const r = await p.chooseClip(q);
    assert.equal(r.error, `I can't do that one: ${reason}.`, JSON.stringify(q));
  }
  p.libraryItems = async () => [{ variant: 'e', files: [{ kind: 'animation', name: 'emote-wave.vrma', label: 'Wave', tags: ['greet'], gesture: 'wave' }] }];
  assert.equal((await p.chooseClip({ clip: 'rumba' })).error, `I can't do that one: ${reason}.`);
  assert.equal(offers(), 0);
  assert.equal((await p.chooseClip({ clip: 'wave' })).choice.file.label, 'Wave');
});

test('only that body: another body, and a video of another role, still dance', async () => {
  const { p, store } = rig('store-vrm-racer-blue');
  store.notForAvatar = { 'vrm-mm-shark': notForAvatar(answer) };
  assert.equal((await p.chooseClip({ asked: 'do the roger rabbit' })).choice.file.label, 'Roger Rabbit');
  assert.match((await p.chooseClip({ asked: 'do the roger rabbit', modelId: 'store-vrm-mm-shark' })).error, /not made to dance/);
});

test('the list is kept from the pass, cleared when the store drops it, and kept through a failed read', async () => {
  const { p, store } = rig();
  let reply = { status: 200, data: Buffer.from(JSON.stringify(answer)) };
  p.fetchLive = async () => reply;
  p.updateOwned = async () => [];
  const passes = [{ slug: 'vrm-mm-shark', key: encrypt('bnbl_s'), state: 'active' }];
  await p.syncLiveClips(passes);
  assert.equal((await p.clipsNotFor()).clips.has('rumba'), true);
  reply = { status: 503, data: Buffer.alloc(0) }; await p.syncLiveClips(passes);
  assert.ok(await p.clipsNotFor());
  reply = { status: 200, data: Buffer.from(JSON.stringify({ packs: answer.packs })) }; await p.syncLiveClips(passes);
  assert.equal(await p.clipsNotFor(), null);
  assert.deepEqual(store.notForAvatar, {});
});

test('a role model with its own pass gets its own list', async () => {
  const { p } = rig('store-vrm-racer-blue');
  p.settings = async () => ({ avatarRoles: { assistant: 'store-vrm-mm-shark' } });
  p.updateOwned = async () => [];
  p.fetchLive = async (url) => ({ status: 200, data: Buffer.from(JSON.stringify(/mm-shark/.test(url) ? answer : { packs: answer.packs })) });
  await p.syncLiveClips([{ slug: 'vrm-racer-blue', key: encrypt('a'), state: 'active' }, { slug: 'vrm-mm-shark', key: encrypt('b'), state: 'active' }]);
  assert.ok(await p.clipsNotFor('store-vrm-mm-shark'));
  assert.equal(await p.clipsNotFor('store-vrm-racer-blue'), null);
});
