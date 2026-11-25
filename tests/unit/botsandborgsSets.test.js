// 3D sets and 360s as store products (3910 #5837): taken like any pack, and a video is filmed in the one it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { variantKind, fileKind, readSetSpec, setNamed, unpack } from '../../src/services/store/assetLibrary.js';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const spec = (id, title, file, x = {}) => ({ format: 'bnb-set/1', id, title, kind: /glb$/.test(file) ? 'mesh' : 'equirect', file, marks: [{ id: 'main', use: ['dance', 'stand'], position: [0, 0, 0], facing_deg: 0 }], camera: {}, ...x });
const SETS = [spec('dance-stage', 'Dance Stage', 'stage.glb'), spec('talking-studio', 'Talking Studio', 'studio.glb'), spec('cosy-room-day', 'Cozy Room, Day', 'cosy.glb'), spec('cosy-room-evening', 'Cozy Room, Evening', 'cosy.glb'),
  spec('snow-field-360', 'Snow Field 360', 's.jpg'), spec('sunset-beach-360', 'Sunset Beach 360', 'b.jpg', { tags: ['sand', 'ocean'] }), spec('night-rooftop-360', 'Night Rooftop 360', 'r.jpg')].map(s => ({ spec: s }));

test('kinds: the product, its specs and its media', () => {
  assert.equal(variantKind('set-sunset-beach-360', 'sets'), 'set'); assert.equal(variantKind('set-dance-stage'), 'set'); assert.equal(variantKind('vrm-racer-blue', '3d-avatars'), 'vrm');
  for (const [n, k] of [['set.json', 'set-spec'], ['cosy/day.set.json', 'set-spec'], ['cosy.glb', 'set-media'], ['beach-4096.jpg', 'set-media'], ['preview-1.jpg', 'preview'], ['README.txt', 'document'], ['other.json', null]]) assert.equal(fileKind(n, 'set'), k, n);
  assert.equal(fileKind('thing.glb', 'portrait'), null, 'elsewhere a .glb is still nothing');
  assert.equal(readSetSpec('{'), null); assert.equal(readSetSpec({ format: 'bnb-set/2', kind: 'mesh', file: 'a.glb' }), null); assert.equal(readSetSpec({ format: 'bnb-set/1', kind: 'mesh', file: 'a.jpg' }), null); assert.ok(readSetSpec(SETS[0].spec));
});

test('the set a request names', () => {
  const at = (t) => setNamed(t, SETS)?.spec.id || null;
  for (const [t, id] of [['send me a video of you dancing on the Sunset Beach', 'sunset-beach-360'], ['a video of you dancing at the beach', 'sunset-beach-360'], ['dancing in the ocean', 'sunset-beach-360'], ['do the rumba on a rooftop at night', 'night-rooftop-360'],
    ['a video of you in the snow', 'snow-field-360'], ['in the cozy room', 'cosy-room-day'], ['in the cosy room in the evening', 'cosy-room-evening'], ['dancing on the dance stage', 'dance-stage'], ['doing the groove on a stage', 'dance-stage'], ['talking in your studio', 'talking-studio'],
    ['send me a video of you dancing', null], ['send me a video of you dancing in your room', null], ['a video for the night', null], ['send Jo a video of you waving', null], ['do a snow angel', null]]) assert.equal(at(t), id, t);
});

test('an owned set is found with its media checked, the mark suits a spoken video, and the video is filmed in it', async () => {
  PluginSettings.getCached = async () => null; PluginSettings.setCached = async () => {};
  const p = new BotsAndBorgsPlugin({ interfaces: new Map(), agentModel: { activeVRMModel: 'm' } }); p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sets-')); p.libraryDir = () => root;
  const { default: JSZip } = await import('jszip');
  const jpg = Buffer.from('a picture'); const glb = Buffer.from('a mesh');
  const z = new JSZip(); z.file('set.json', JSON.stringify(spec('sunset-beach-360', 'Sunset Beach 360', 'b.jpg', { sha256: sha(jpg), marks: [{ id: 'main', use: ['dance'] }, { id: 'side', use: ['talk'] }] }))); z.file('b.jpg', jpg); z.file('preview-1.jpg', 'x');
  const files = await unpack(await z.generateAsync({ type: 'nodebuffer' }), { type: 'application/zip', kind: 'set' });
  assert.deepEqual(files.map(f => [f.name, f.kind]).sort(), [['b.jpg', 'set-media'], ['preview-1.jpg', 'preview'], ['set.json', 'set-spec']]);
  const put = (v, list) => { fs.mkdirSync(path.join(root, v)); for (const f of list) fs.writeFileSync(path.join(root, v, f.name), f.buffer); return { variant: v, title: v, files: list.map(f => ({ name: f.name, kind: f.kind })) }; };
  const bad = [{ name: 'set.json', kind: 'set-spec', buffer: Buffer.from(JSON.stringify(spec('dance-stage', 'Dance Stage', 's.glb', { sha256: sha(Buffer.from('another')) }))) }, { name: 's.glb', kind: 'set-media', buffer: glb }];
  const items = [put('set-sunset-beach-360', files), put('set-dance-stage', bad)]; p.libraryItems = async () => items;
  assert.deepEqual((await p.ownedSets()).map(s => s.spec.id), ['sunset-beach-360'], 'the one whose media is another file is left out');
  const set = await p.setFor('dancing on the beach'); assert.equal(path.basename(set.setPath), 'b.jpg'); assert.equal(set.setSpec.mark, undefined);
  assert.equal((await p.setFor('on the beach', { speaking: true })).setSpec.mark, 'side'); assert.equal(await p.setFor('on the dance stage'), null); assert.equal(await p.setFor('dancing'), null);
  let got; p.renderVideo = async (o) => { got = o; return { video: Buffer.from('v'), seconds: 3, bytes: 1, width: 1, height: 1 }; };
  p.agent.interfaces = new Map([['telegram', { authorizedUserId: 1, bot: { telegram: { sendVideo: async () => {} } } }]]);
  p.modelFor = async () => ({ id: 'm', file: 'm.vrm', name: 'M', role: 'personal' }); p.avatarLooks = async () => ({}); p.readyClip = async () => null; p.clipFileFor = async () => 'c'; p.propsForBody = async () => []; p.vrmDir = () => root;
  p.chooseClip = async () => ({ choice: { file: { label: 'Rumba' } }, entry: { label: 'Rumba', loop: true }, rel: 'c' }); let asked = 0; p.backgroundFor = async () => { asked++; return '/bg.jpg'; };
  const r = await p.sendClipVideo({ asked: 'send me a video of you doing the rumba on the Sunset Beach', to: 'me', wait: true }); assert.equal(r.success, true, r.error);
  assert.equal(path.basename(got.setPath), 'b.jpg'); assert.equal(got.setSpec.id, 'sunset-beach-360'); assert.equal(got.backgroundPath, undefined); assert.equal(asked, 0);
  await p.sendClipVideo({ asked: 'send me a video of you doing the rumba', to: 'me', wait: true }); assert.equal(got.setPath, undefined); assert.equal(got.backgroundPath, '/bg.jpg');
});
