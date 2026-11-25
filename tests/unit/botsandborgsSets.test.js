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

test('sets go to AvatarX as stored zips, once; an older AvatarX gets none', async () => {
  const { pushSetsToAvatarX, backgroundOnAvatarX } = await import('../../src/services/avatar/avatarx.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axs-')); const keyFile = path.join(dir, 'k'); fs.writeFileSync(keyFile, 'k'); const media = path.join(dir, 'b.jpg'); fs.writeFileSync(media, 'a picture');
  const sets = [{ spec: spec('sunset-beach-360', 'Sunset Beach 360', 'b.jpg', { sha256: sha(Buffer.from('a picture')) }), mediaPath: media }];
  let held = []; const sent = [];
  const fetchFn = async (u, o) => { if (o.method === 'GET') return { ok: true, status: 200, json: async () => ({ sets: held, backgrounds: ['nebula'], background: 'nebula' }) }; sent.push({ m: o.method, u: String(u), body: o.body }); return { ok: true, status: 200, json: async () => ({}) }; };
  const opts = { url: 'https://ax', keyFile, fetchFn };
  const first = await pushSetsToAvatarX(sets, opts); assert.deepEqual(Object.keys(first), ['sunset-beach-360']); assert.equal(sent.length, 1);
  const { default: JSZip } = await import('jszip'); const z = await JSZip.loadAsync(sent[0].body); assert.deepEqual(Object.keys(z.files).sort(), ['b.jpg', 'set.json']); assert.equal(JSON.parse(await z.file('set.json').async('string')).id, 'sunset-beach-360');
  assert.equal(Buffer.from(sent[0].body).readUInt16LE(8), 0, 'stored, not deflated');
  held = [{ id: 'sunset-beach-360' }]; await pushSetsToAvatarX(sets, { ...opts, sent: first }); assert.equal(sent.length, 1, 'not again');
  await pushSetsToAvatarX([{ ...sets[0], spec: { ...sets[0].spec, camera: { main: { arc_deg: [-36, 36] } } } }], { ...opts, sent: first }); assert.equal(sent.length, 2, 'a new version');
  held = undefined; assert.equal(await pushSetsToAvatarX(sets, opts), 'unsupported');
  held = [{ id: 'sunset-beach-360' }]; assert.deepEqual(await backgroundOnAvatarX('sunset-beach-360', opts), { before: 'nebula' }); assert.equal(JSON.parse(sent.at(-1).body).background, 'sunset-beach-360'); assert.equal(await backgroundOnAvatarX('moon', opts), null);
});

test('where the body is asked to be', async () => {
  const { placeRequest } = await import('../../src/services/avatar/moveRequest.js');
  for (const [t, w] of [['go to the beach', 'go'], ['put yourself in the cozy room', 'go'], ['change the background to the desert', 'go'], ['do the rumba on the rooftop', 'go'], ["let's go to the snow", 'go'], ['go back to your normal background', 'leave'], ['leave the beach', 'leave'],
    ['send me a video of you on the beach', null], ['I went swimming', null], ['what is the weather', null], ['remind me to go to the beach tomorrow', null]]) assert.equal(placeRequest(t), w, t);
});

test('twenty-four sets on ALICE (2026-11-25): each is what its words say', () => {
  const s = (id, title, tags) => ({ spec: { id, title, tags: tags.split(',') } });
  const all = [s('alley', 'The Alley', 'alley,street,night,brick,graffiti,city'), s('attic-loft', 'Attic Loft', 'attic,loft,cozy,wood,bedroom,day,indoor'), s('aurora-lake-360', 'Aurora Lake', 'aurora,ice,lake,night,winter,outdoor'), s('bookshop-nook', 'Bookshop Nook', 'books,shop,cozy,reading,wood,indoor'), s('cloud-sea-360', 'Cloud Sea Platform', 'clouds,sky,sunrise,platform,mountains,outdoor'), s('cozy-room-day', 'Cozy Room, Day', 'room,cozy,living-room,day,indoor'), s('cozy-room-evening', 'Cozy Room, Evening', 'room,cozy,living-room,evening,indoor'), s('dance-stage', 'Dance Stage', 'stage,dance,neon,indoor'), s('desert-dunes-360', 'Desert Dunes 360', 'desert,dunes,sand,sunset,outdoor'), s('forest-clearing-360', 'Forest Clearing 360', 'forest,trees,grass,nature,day,outdoor'), s('gaming-den', 'Gaming Den', 'gaming,den,neon,night,computer,indoor'), s('keynote-stage', 'Keynote Stage', 'stage,keynote,talk,speech,conference,indoor'), s('lava-field-360', 'Lava Field', 'lava,volcano,fire,night,outdoor'), s('metal-stage', 'Metal Concert Stage', 'stage,concert,metal,rock,band,night,fire'), s('night-rooftop-360', 'Night Rooftop 360', 'rooftop,city,night,outdoor'), s('orbit-deck-360', 'Orbital Deck', 'space,planet,station,stars,scifi,night'), s('pop-concert-stage', 'Pop Concert Stage', 'stage,dance,concert,neon,indoor'), s('red-planet-dusk-360', 'Red Planet Dusk 360', 'planet,desert,space,dusk,outdoor'), s('salt-flat-360', 'Salt Flat Mirror', 'salt,desert,water,sunrise,outdoor'), s('snow-field-360', 'Snow Field 360', 'snow,winter,mountains,outdoor'), s('sunset-beach-360', 'Sunset Beach 360', 'beach,sunset,sea,outdoor'), s('talk-stage', 'Talk Stage', 'stage,talk,speech,space,conference,indoor'), s('talking-studio', 'Talking Studio', 'studio,podcast,talk,indoor'), s('zen-tea-room', 'Zen Tea Room', 'zen,tea,calm,wood,paper,day,indoor')];
  for (const [t, id] of [['on the dance stage', 'dance-stage'], ['on the stage', 'dance-stage'], ['on the pop concert stage', 'pop-concert-stage'], ['on the metal stage', 'metal-stage'], ['at the keynote', 'keynote-stage'], ['on the talk stage', 'talk-stage'], ['in your studio', 'talking-studio'],
    ['in the cozy room', 'cozy-room-day'], ['in the cozy room in the evening', 'cozy-room-evening'], ['in the gaming den', 'gaming-den'], ['in a bookshop', 'bookshop-nook'], ['in the attic', 'attic-loft'], ['in a tea room', 'zen-tea-room'], ['in an alley', 'alley'], ['in the forest', 'forest-clearing-360'],
    ['on red planet', 'red-planet-dusk-360'], ['on the red planet', 'red-planet-dusk-360'], ['in the clouds', 'cloud-sea-360'], ['in space', 'orbit-deck-360'], ['on the lava field', 'lava-field-360'], ['under the aurora', 'aurora-lake-360'], ['on the beach', 'sunset-beach-360'], ['in the desert', 'desert-dunes-360'], ['in the snow', 'snow-field-360'], ['on the rooftop', 'night-rooftop-360'], ['on the salt flat', 'salt-flat-360'],
    ['at night', null], ['in a room', null], ['in a red dress', null], ['in the evening', null], ['for a dance', null]]) assert.equal(setNamed(`a video of you dancing ${t}`, all)?.spec.id || null, id, t);
});
