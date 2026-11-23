// A props pack's own "not on these bodies" (attach.json unsupported_on, 3910 #3205): read when there is no fitted row,
// so a prop that does not fit a hand is not shown on it before the store has fitted that body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { propAttachments, notOnBody } from '../../src/services/store/assetLibrary.js';
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
