// A props pack's own "not on these bodies" (attach.json unsupported_on, 3910 #3205): read when there is no fitted row,
// so a prop that does not fit a hand is not shown on it before the store has fitted that body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { propAttachments, notOnBody, seatFor, writeStoreAnimations } from '../../src/services/store/assetLibrary.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

const attach = { props: [{ prop: 'boombox', file: 'boombox.glb', kind: 'hand',
  clips: { 'boombox-carry-bob': { standard: { bone: 'rightHand', position: [0, 0, 0], rotation: [0, 0, 0] } }, 'boombox-dance': { standard: { bone: 'rightHand', position: [0, 0, 0], rotation: [0, 0, 0] } } },
  unsupported_on: [{ bodies: ['racer-blue', 'swim-blue'], clips: ['boombox-carry-bob', 'boombox-carry-bob-in'], reason: 'small hand, later version' }, { bodies: ['racer-blue'], clips: ['boombox-carry-bob'], reason: 'second' }] }] };

test('entries go with the clips they name; the first match wins; odd entries are ignored', () => {
  const a = propAttachments(attach);
  assert.equal(notOnBody(a.get('boombox-carry-bob')[0], 'racer-blue'), 'small hand, later version');
  assert.equal(notOnBody(a.get('boombox-carry-bob')[0], 'racer-red'), null);
  assert.equal(notOnBody(a.get('boombox-dance')[0], 'racer-blue'), null);
  assert.equal(notOnBody(a.get('boombox-carry-bob')[0], null), null);
  assert.equal(a.get('boombox-dance')[0].unsupported_on, undefined);
  for (const bad of ['x', [{}], [{ bodies: 'racer-blue', clips: ['boombox-carry-bob'] }], [null]]) {
    assert.equal(propAttachments({ props: [{ ...attach.props[0], unsupported_on: bad }] }).get('boombox-carry-bob')[0].unsupported_on, undefined);
  }
});

function rig(active) {
  const store = {};
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const p = new BotsAndBorgsPlugin({ interfaces: new Map(), agentModel: { activeVRMModel: active } });
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  p.vrmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-unsup-'));
  const files = { 'blue.vrm': 'racer-blue-bytes', 'red.vrm': 'racer-red-bytes!', 'linkblue.vrm': 'racer-blue-bytes', 'linkown.vrm': 'someone-elses-own' };
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(p.vrmRoot, f), c);
  fs.writeFileSync(path.join(p.vrmRoot, 'manifest.json'), JSON.stringify([{ id: 'store-vrm-racer-blue-bundle', file: 'blue.vrm' }, { id: 'store-vrm-racer-red', file: 'red.vrm' },
    { id: 'store-linked-l-a-base', file: 'linkblue.vrm' }, { id: 'store-linked-l-b-base', file: 'linkown.vrm' }]));
  const at = propAttachments(attach).get('boombox-carry-bob')[0];
  fs.mkdirSync(path.join(p.vrmRoot, 'animations'), { recursive: true });
  fs.writeFileSync(path.join(p.vrmRoot, 'animations', 'store.json'), JSON.stringify([{ file: 'store/vrm-props-pack-5/boombox-carry-bob.vrma', label: 'Boombox Carry Bob', props: [at] }]));
  p.libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-unsuplib-'));
  p.libraryItems = async () => [{ variant: 'vrm-props-pack-5', title: 'Music', files: [{ kind: 'animation', name: 'boombox-carry-bob.vrma', label: 'Boombox Carry Bob', tags: ['boombox'] }, { kind: 'animation', name: 'wave.vrma', label: 'Wave', gesture: 'wave' }] }];
  p.requiredProps = async () => new Map([['boombox-carry-bob.vrma', ['boombox']]]);
  p.wornBody = async () => 'female'; p.bodyOf = async () => 'female'; p.storeOffer = async () => '';
  return { p, store, at };
}

test('a listed body: no prop in videos, and the clip that needs it is refused with the reason; another body has both', async () => {
  const { p, at } = rig('store-vrm-racer-blue-bundle');
  assert.deepEqual(await p.propsForBody([at], {}), []);
  assert.equal((await p.propsForBody([at], { modelId: 'store-vrm-racer-red' })).length, 1);
  assert.match((await p.chooseClip({ clip: 'boombox carry bob' })).error, /small hand, later version/);
  assert.equal((await p.chooseClip({ clip: 'wave' })).choice.file.label, 'Wave');
  assert.equal((await p.chooseClip({ clip: 'boombox carry bob', modelId: 'store-vrm-racer-red' })).choice.file.label, 'Boombox Carry Bob');
});

test('a linked body is matched by its file only: the same bytes as a store model, or nothing', async () => {
  const { p, at } = rig('store-linked-l-a-base');
  assert.equal(await p.bodyName(), 'racer-blue');
  assert.deepEqual(await p.propsForBody([at], {}), []);
  assert.equal(await p.bodyName('store-linked-l-b-base'), null);
  assert.equal((await p.propsForBody([at], { modelId: 'store-linked-l-b-base' })).length, 1);
});

test('the fit status goes first: a prop the store fitted to this very body is shown; an unsupported one is not', async () => {
  const { p, store, at } = rig('store-vrm-racer-blue-bundle');
  const sha = crypto.createHash('sha256').update('racer-blue-bytes').digest('hex');
  const fit = (state, s = sha) => ({ slug: 'vrm-racer-blue', vrm_sha256: s, props: [{ prop: 'boombox', state }] });
  store.liveFit = fit('fitted'); assert.equal((await p.propsForBody([at], {})).length, 1);
  store.liveFit = fit('pending'); assert.equal((await p.propsForBody([at], {})).length, 0);
  store.liveFit = fit('unsupported'); assert.equal((await p.propsForBody([at], {})).length, 0);
  store.liveFit = fit('fitted', 'another-body'); assert.equal((await p.propsForBody([at], {})).length, 0, 'a fit for another file says nothing');
});

// Families: where a prop sits on some bodies, and the build of it they wear (the pack's attach.json; AvatarX 0.4.15).
const fam = { props: [{ prop: 'boombox', file: 'boombox.glb', kind: 'hand', clips: { 'boombox-carry-bob': { standard: { bone: 'rightHand', position: [0, 0, 0], rotation: [0, 0, 0], show: [0, 2] } } },
  families: { large: { bodies: ['vrm-racer-red'], bone: 'leftHand', position: [0.1, 0, 0], rotation: [0, 90, 0], file: 'boombox_l.glb' }, odd: { bodies: [] }, bad: { bodies: ['x'], bone: 'rightHand', position: [1, 2], rotation: [0, 0, 0] } },
  unsupported_on: [{ bodies: ['racer-blue'], clips: ['boombox-carry-bob'], reason: 'small hand, later version' }] }] };

function library(extra = ['boombox_l.glb']) {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-lib-')), vrm = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-vrm-'));
  const d = path.join(lib, 'vrm-props-pack-5'); fs.mkdirSync(d);
  for (const f of ['boombox.glb', ...extra]) fs.writeFileSync(path.join(d, f), `glTF ${f}`);
  fs.writeFileSync(path.join(d, 'attach.json'), JSON.stringify(fam)); fs.writeFileSync(path.join(d, 'boombox-carry-bob.vrma'), 'clip');
  const items = [{ variant: 'vrm-props-pack-5', title: 'Music', files: [{ name: 'boombox-carry-bob.vrma', kind: 'animation', label: 'Boombox Carry Bob', loop: true },
    ...['boombox.glb', ...extra].map(name => ({ name, kind: 'prop' })), { name: 'attach.json', kind: 'prop-manifest' }] }];
  return { lib, vrm, items };
}

test('a family body gets its seat and build, the clip keeps its timing; other bodies and bad seats are as listed', async () => {
  const { lib, vrm, items } = library();
  const [entry] = await writeStoreAnimations(items, lib, vrm);
  const [p] = entry.props;
  assert.ok(fs.existsSync(path.join(vrm, 'props/vrm-props-pack-5/boombox_l.glb')));
  assert.deepEqual(p.families.map(f => f.name), ['large']);
  const red = seatFor(p, 'racer-red');
  assert.equal(red.bone, 'leftHand'); assert.deepEqual(red.position, [0.1, 0, 0]); assert.equal(red.file, 'props/vrm-props-pack-5/boombox_l.glb'); assert.deepEqual(red.show, [0, 2]);
  assert.equal(seatFor(p, 'racer-green'), p); assert.equal(seatFor(p, null), p);
  const no = library([]); const warns = [];
  const [e2] = await writeStoreAnimations(no.items, no.lib, no.vrm, { warn: (m) => warns.push(m) });
  assert.equal(e2.props[0].families, undefined); assert.match(warns.join(), /boombox_l\.glb for large, not in the pack/);
});

test('AvatarX gets the body list, the seats and their builds; nothing is sent twice', async () => {
  const { pushPropsToAvatarX } = await import('../../src/services/avatar/avatarx.js');
  const { lib, vrm, items } = library();
  const listed = await writeStoreAnimations(items, lib, vrm);
  const keyFile = path.join(vrm, 'key'); fs.writeFileSync(keyFile, 'k');
  const run = async (state) => {
    const calls = [];
    await pushPropsToAvatarX(listed, vrm, { url: 'http://x', keyFile, fetchFn: async (url, o) => { calls.push({ m: o.method, url: url.split('/agent/v1/')[1], body: o.body }); return { ok: true, status: 200, json: async () => (o.method === 'GET' ? state : {}) }; } });
    return calls.filter(c => c.m !== 'GET');
  };
  const first = await run({ props: [] });
  assert.deepEqual(first.map(c => c.url), ['props?name=boombox', 'props?name=boombox&file=boombox_l.glb', 'props?name=boombox']);
  const sent = JSON.parse(first[2].body);
  assert.deepEqual(sent.unsupported_on, [{ bodies: ['racer-blue'], clips: ['boombox-carry-bob'], reason: 'small hand, later version' }]);
  assert.deepEqual(sent.families.large.bodies, ['racer-red']); assert.equal(sent.families.large.file, 'boombox_l.glb');
  // What AvatarX 0.4.15 answers for it (its normalized form): the same, so nothing more is sent.
  const len = fs.statSync(path.join(vrm, 'props/vrm-props-pack-5/boombox.glb')).size, lenL = fs.statSync(path.join(vrm, 'props/vrm-props-pack-5/boombox_l.glb')).size;
  const held = { name: 'boombox', rev: `${len}-1-2-3`, clips: sent.clips, unsupported: sent.unsupported_on, files: { boombox_l: `${lenL}-9` },
    families: { large: { bodies: ['racer-red'], bone: 'leftHand', position: [0.1, 0, 0], rotation: [0, 90, 0], file: 'boombox_l' } } };
  assert.deepEqual(await run({ props: [held] }), []);
  assert.deepEqual((await run({ props: [{ ...held, unsupported: [] }] })).map(c => c.url), ['props?name=boombox']);
});
