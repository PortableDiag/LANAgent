// Bots & Borgs props ("bots-and-borgs props 1", 2119 #494): a .glb attached to a bone (or the floor) while a clip
// that uses it plays. Without a props pack, everything lists and plays exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { variantKind, fileKind, propAttachments, writeStoreAnimations } from '../../src/services/store/assetLibrary.js';
import { validAttachment, propUrl } from '../../src/interfaces/web/public/lib/vrm-props.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-props-'));
const attach = {
  format: 'bots-and-borgs props 1',
  props: [
    { prop: 'phone', file: 'phone.glb', kind: 'hand', clips: { 'phone-call-loop': {
      standard: { bone: 'rightHand', position: [0.02, 0.05, 0.01], rotation: [0, 90, 10] },
      broad: { bone: 'rightHand', position: [0.03, 0.06, 0.01], rotation: [0, 90, 12] } } } },
    { prop: 'chair', file: 'chair.glb', kind: 'floor', clips: { 'seated-idle-loop': { standard: { bone: 'floor', position: [0, 0, -0.3], rotation: [0, 180, 0] } } } },
    { prop: 'bad', file: 'bad.glb', clips: { 'phone-call-loop': { standard: { bone: 'leftHand', position: [0, 'x', 0], rotation: [0, 0, 0] } } } }
  ]
};

test('a props pack is a prop, never a model; its files are props and the attach manifest', () => {
  assert.equal(variantKind('vrm-props-pack-1'), 'prop');
  assert.equal(variantKind('vrm-props-pack-1-phone'), 'prop');
  assert.equal(variantKind('anything', 'props'), 'prop');
  assert.equal(variantKind('vrm-mm-bear'), 'vrm', 'a model stays a model');
  assert.equal(variantKind('vrm-agent-animations-4'), 'animation', 'a clip pack stays a clip pack');
  assert.equal(fileKind('phone.glb', 'prop'), 'prop');
  assert.equal(fileKind('attach.json', 'prop'), 'prop-manifest');
  assert.equal(fileKind('clips.json', 'prop'), 'clip-manifest');
  assert.equal(fileKind('stray.glb', 'animation'), null, 'a .glb outside a props pack is ignored');
  assert.equal(fileKind('attach.json', 'animation'), null);
});

test('attach.json: standard fit by default, broad when asked, malformed entries dropped', () => {
  const std = propAttachments(attach);
  assert.deepEqual([...std.keys()].sort(), ['phone-call-loop', 'seated-idle-loop']);
  assert.equal(std.get('phone-call-loop').length, 1, 'the entry with a non-number position is left out');
  assert.deepEqual(std.get('phone-call-loop')[0], { prop: 'phone', file: 'phone.glb', kind: 'hand', bone: 'rightHand', position: [0.02, 0.05, 0.01], rotation: [0, 90, 10] });
  assert.equal(std.get('seated-idle-loop')[0].bone, 'floor');
  assert.deepEqual(propAttachments(attach, { fit: 'broad' }).get('phone-call-loop')[0].position, [0.03, 0.06, 0.01]);
  assert.equal(propAttachments(attach, { fit: 'broad' }).get('seated-idle-loop')[0].bone, 'floor', 'no broad entry: standard');
  assert.equal(propAttachments(null).size, 0);
  assert.equal(propAttachments({ props: 'nope' }).size, 0);
});

async function library({ withProps }) {
  const lib = tmp(), vrm = tmp();
  const items = [{ variant: 'vrm-agent-animations-4', title: 'VRM Agent Animations: Set Four', files: [
    { name: 'phone-call-loop.vrma', kind: 'animation', label: 'Phone Call Loop', loop: true },
    { name: 'talk-loop-2.vrma', kind: 'animation', label: 'Talk Loop 2', loop: true }] }];
  fs.mkdirSync(path.join(lib, 'vrm-agent-animations-4'));
  for (const f of items[0].files) fs.writeFileSync(path.join(lib, 'vrm-agent-animations-4', f.name), Buffer.from('clip'));
  if (withProps) {
    items.push({ variant: 'vrm-props-pack-1', title: 'VRM Props Pack 1', files: [
      { name: 'phone.glb', kind: 'prop' }, { name: 'chair.glb', kind: 'prop' }, { name: 'attach.json', kind: 'prop-manifest' }] });
    const d = path.join(lib, 'vrm-props-pack-1'); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'phone.glb'), Buffer.from('glTFphone'));
    fs.writeFileSync(path.join(d, 'chair.glb'), Buffer.from('glTFchair'));
    fs.writeFileSync(path.join(d, 'attach.json'), JSON.stringify(attach));
  }
  return { lib, vrm, items };
}

test('without a props pack, clips list exactly as before: no props field, no props folder', async () => {
  const { lib, vrm, items } = await library({ withProps: false });
  const out = await writeStoreAnimations(items, lib, vrm);
  assert.equal(out.length, 2);
  assert.ok(out.every(c => !('props' in c)));
  assert.equal(fs.existsSync(path.join(vrm, 'props')), false);
});

test('with a props pack, the clip that uses a prop lists it, served under vrm-models/props; others do not', async () => {
  const { lib, vrm, items } = await library({ withProps: true });
  const warned = [];
  const out = await writeStoreAnimations(items, lib, vrm, { warn: (m) => warned.push(m) });
  const phone = out.find(c => c.label === 'Phone Call Loop');
  assert.equal(phone.props.length, 1);
  assert.equal(phone.props[0].file, 'props/vrm-props-pack-1/phone.glb');
  assert.equal(phone.props[0].bone, 'rightHand');
  assert.ok(!('props' in out.find(c => c.label === 'Talk Loop 2')));
  assert.equal(fs.readFileSync(path.join(vrm, 'props', 'vrm-props-pack-1', 'phone.glb'), 'utf8'), 'glTFphone');
  // The chair's clip is not owned: the chair is listed on nothing and not copied.
  assert.equal(fs.existsSync(path.join(vrm, 'props', 'vrm-props-pack-1', 'chair.glb')), true, 'copied for when its clip arrives');
  assert.deepEqual(warned, []);
  const listed = JSON.parse(fs.readFileSync(path.join(vrm, 'animations', 'store.json'), 'utf8'));
  assert.equal(listed.find(c => c.label === 'Phone Call Loop').props[0].prop, 'phone');
});

test('a broken attach.json or a missing .glb is skipped, the clips still list', async () => {
  const { lib, vrm, items } = await library({ withProps: true });
  fs.writeFileSync(path.join(lib, 'vrm-props-pack-1', 'attach.json'), '{not json');
  const warned = [];
  const out = await writeStoreAnimations(items, lib, vrm, { warn: (m) => warned.push(m) });
  assert.equal(out.length, 2);
  assert.ok(out.every(c => !('props' in c)));
  assert.match(warned[0], /attach\.json unreadable/);
  const b = await library({ withProps: true });
  fs.rmSync(path.join(b.lib, 'vrm-props-pack-1', 'phone.glb'));
  const w2 = [];
  const out2 = await writeStoreAnimations(b.items, b.lib, b.vrm, { warn: (m) => w2.push(m) });
  assert.ok(!('props' in out2.find(c => c.label === 'Phone Call Loop')));
  assert.match(w2.join('\n'), /phone\.glb missing/);
});

test('the page-side check refuses a malformed attachment and builds the served URL', () => {
  assert.equal(validAttachment({ bone: 'rightHand', file: 'props/p/phone.glb', position: [0, 0, 0], rotation: [0, 90, 0] }), true);
  assert.equal(validAttachment({ bone: 'rightHand', file: 'x.glb', position: [0, 0], rotation: [0, 0, 0] }), false);
  assert.equal(validAttachment({ bone: 'right hand', file: 'x.glb', position: [0, 0, 0], rotation: [0, 0, 0] }), false);
  assert.equal(validAttachment({ bone: 'floor', position: [0, 0, 0], rotation: [0, 0, 0] }), false, 'no file');
  assert.equal(validAttachment(null), false);
  assert.equal(propUrl({ file: 'props/vrm-props-pack-1/my phone.glb' }), '/vrm-models/props/vrm-props-pack-1/my%20phone.glb');
  assert.equal(propUrl({ url: '/prop/0.glb', file: 'ignored' }), '/prop/0.glb');
});

test('a VRM 0.x body is known by its meta version (its prop frame is turned 180°)', async () => {
  const { isVrm0 } = await import('../../src/interfaces/web/public/lib/vrm-props.js');
  assert.equal(isVrm0({ meta: { metaVersion: '0' } }), true);
  assert.equal(isVrm0({ meta: { metaVersion: '1' } }), false);
  assert.equal(isVrm0({}), false);
});

async function avatarxStub(state) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'key'), 'k');
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method, type: init.headers['Content-Type'], body: init.body });
    if (url.endsWith('/agent/v1/state')) return { ok: true, json: async () => state };
    return { ok: true, json: async () => ({ prop: 'phone', part: 'model', ready: true }) };
  };
  return { dir, calls, opts: { url: 'https://avatarx.test', keyFile: path.join(dir, 'key'), fetchFn } };
}

test('AvatarX gets each owned prop: the .glb, then an attach naming its AvatarX clips; nothing without props', async () => {
  const { pushPropsToAvatarX } = await import('../../src/services/avatar/avatarx.js');
  const vrm = tmp();
  fs.mkdirSync(path.join(vrm, 'props', 'p'), { recursive: true });
  fs.writeFileSync(path.join(vrm, 'props', 'p', 'phone.glb'), Buffer.from('glTFphone'));
  const listed = [{ file: 'store/x/phone-call-loop.vrma', props: [{ prop: 'phone', file: 'props/p/phone.glb', bone: 'rightHand', position: [0, 0.1, 0], rotation: [0, 90, 0] }] },
    { file: 'store/x/talk-loop-2.vrma' }];
  const a = await avatarxStub({ props: [] });
  assert.deepEqual(await pushPropsToAvatarX(listed, vrm, a.opts), ['phone']);
  const posts = a.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.match(posts[0].url, /\/agent\/v1\/props\?name=phone$/);
  assert.equal(posts[0].type, 'application/octet-stream');
  assert.deepEqual(JSON.parse(posts[1].body), { clips: { 'phone-call-loop': { bone: 'rightHand', position: [0, 0.1, 0], rotation: [0, 90, 0] } } });
  // Held already, same size and placements: nothing sent again.
  const b = await avatarxStub({ props: [{ name: 'phone', rev: '9-1-50-2', clips: { 'phone-call-loop': { bone: 'rightHand', position: [0, 0.1, 0], rotation: [0, 90, 0], scale: 1 } } }] });
  assert.deepEqual(await pushPropsToAvatarX(listed, vrm, b.opts), ['phone']);
  assert.equal(b.calls.filter(c => c.method === 'POST').length, 0);
  // An AvatarX older than props: told, nothing sent. No props owned: no call at all.
  const c = await avatarxStub({ animations: [] });
  assert.equal(await pushPropsToAvatarX(listed, vrm, c.opts), 'unsupported');
  assert.equal(c.calls.filter(x => x.method === 'POST').length, 0);
  const d = await avatarxStub({ props: [] });
  assert.deepEqual(await pushPropsToAvatarX([{ file: 'store/x/a.vrma' }], vrm, d.opts), []);
  assert.equal(d.calls.length, 0);
});

test('a placement made to scale (scale_with body, ref_hips) sizes to this body by its STANDING hips; others stay real size', async () => {
  const { bodyScale, standingHips } = await import('../../src/interfaces/web/public/lib/vrm-props.js');
  const vrm = (y) => ({ humanoid: { normalizedRestPose: { hips: { position: [0, y, 0] } } }, scene: { scale: { y: 1 } } });
  const chair = { scale_with: 'body', ref_hips: 0.92 };
  assert.equal(standingHips(vrm(0.81)), 0.81);
  assert.ok(Math.abs(bodyScale(vrm(0.81), chair) - 0.81 / 0.92) < 1e-9);
  assert.equal(bodyScale(vrm(0.81), { ref_hips: 0.92 }), 1, 'no scale_with: real size');
  assert.equal(bodyScale(vrm(0.81), { scale_with: 'body' }), 1, 'no ref_hips: real size');
  assert.equal(bodyScale({ humanoid: {} }, chair), 1, 'unknown hips: real size');
  // The parser keeps the fields; the placement's own value wins over the prop's.
  const m = { props: [{ prop: 'chair', file: 'chair.glb', kind: 'floor', scale_with: 'body', ref_hips: 0.9,
    clips: { 'seated-idle-loop': { standard: { bone: 'floor', position: [0, 0, -0.05], rotation: [0, 0, 0], ref_hips: 0.92 } },
             'sit-to-stand': { standard: { bone: 'floor', position: [0, 0, 0], rotation: [0, 0, 0] } } } },
    { prop: 'phone', file: 'phone.glb', clips: { 'phone-call-loop': { standard: { bone: 'rightHand', position: [0, 0, 0], rotation: [0, 0, 0] } } } }] };
  const att = propAttachments(m);
  assert.equal(att.get('seated-idle-loop')[0].ref_hips, 0.92);
  assert.equal(att.get('seated-idle-loop')[0].scale_with, 'body');
  assert.equal(att.get('sit-to-stand')[0].ref_hips, 0.9, 'from the prop');
  assert.ok(!('scale_with' in att.get('phone-call-loop')[0]), 'a phone stays real size');
});

test('the mic shows only when asked or in a studio scene; other props always (owner, 2026-11-15)', async () => {
  const { propsFor, PROPS_ON_REQUEST } = await import('../../src/services/store/assetLibrary.js');
  assert.deepEqual(PROPS_ON_REQUEST, ['mic']);
  const mic = { prop: 'mic', onRequest: true }, phone = { prop: 'phone' };
  assert.deepEqual(propsFor([mic, phone]), [phone]);
  assert.deepEqual(propsFor([mic], { asked: 'send me a video of you talking' }), []);
  assert.deepEqual(propsFor([mic], { asked: 'make a podcast style video' }), [mic]);
  assert.deepEqual(propsFor([mic], { asked: 'talk into a microphone' }), [mic]);
  assert.deepEqual(propsFor([mic], { scene: '/x/bg-studios-rooms-pack/Podcast Booth 1080x1920.jpg' }), [mic]);
  assert.deepEqual(propsFor([mic], { scene: '/x/bg-space-decks-pack/Bridge 1080x1920.jpg' }), []);
  assert.deepEqual(propsFor(undefined), []);
});

test('the store listing marks the mic on-request and AvatarX never gets it', async () => {
  const lib = tmp(), vrm = tmp();
  const items = [{ variant: 'vrm-agent-animations-4', title: 'Set Four', files: [{ name: 'talk-loop-2.vrma', kind: 'animation', label: 'Talk Loop 2' }, { name: 'phone-call-loop.vrma', kind: 'animation', label: 'Phone Call Loop' }] },
    { variant: 'vrm-props-pack-1', title: 'Props', files: [{ name: 'mic.glb', kind: 'prop' }, { name: 'phone.glb', kind: 'prop' }, { name: 'attach.json', kind: 'prop-manifest' }] }];
  fs.mkdirSync(path.join(lib, 'vrm-agent-animations-4')); fs.mkdirSync(path.join(lib, 'vrm-props-pack-1'));
  for (const f of items[0].files) fs.writeFileSync(path.join(lib, 'vrm-agent-animations-4', f.name), 'clip');
  fs.writeFileSync(path.join(lib, 'vrm-props-pack-1', 'mic.glb'), 'glTFmic'); fs.writeFileSync(path.join(lib, 'vrm-props-pack-1', 'phone.glb'), 'glTFphone');
  fs.writeFileSync(path.join(lib, 'vrm-props-pack-1', 'attach.json'), JSON.stringify({ props: [
    { prop: 'mic', file: 'mic.glb', kind: 'floor', clips: { 'talk-loop-2': { standard: { bone: 'floor', position: [0, 0, 0.41], rotation: [0, 0, 0] } } } },
    { prop: 'phone', file: 'phone.glb', kind: 'hand', clips: { 'phone-call-loop': { standard: { bone: 'rightHand', position: [0, 0, 0], rotation: [0, 0, 0] } } } }] }));
  const out = await writeStoreAnimations(items, lib, vrm);
  assert.equal(out.find(c => c.label === 'Talk Loop 2').props[0].onRequest, true);
  assert.ok(!out.find(c => c.label === 'Phone Call Loop').props[0].onRequest);
  const { pushPropsToAvatarX } = await import('../../src/services/avatar/avatarx.js');
  const a = await avatarxStub({ props: [] });
  assert.deepEqual(await pushPropsToAvatarX(out, vrm, a.opts), ['phone']);
});

// The owner's party horn (2026-11-23): it unrolled when the clip began and lay rolled up at the mouth. `at` says when.
test("a prop's own movement plays at its times, again on each loop, and `at` reaches the pages and AvatarX", async () => {
  const { startsAt, updateProps } = await import('../../src/interfaces/web/public/lib/vrm-props.js');
  assert.equal(startsAt([1, 2], 0.96, 1), true); assert.equal(startsAt([1, 2], 1, 1.04), false); assert.equal(startsAt([1, 2], 1.98, 2.02), true);
  assert.equal(startsAt([1, 2], 3.98, 0.02), false, 'looped, nothing there'); assert.equal(startsAt([0.01], 3.98, 0.02), true); assert.equal(startsAt([3.99], 3.98, 0.02), true);
  assert.equal(startsAt([0], null, 0), true); assert.equal(startsAt([1], null, 0), false); assert.equal(startsAt([1], null, 3), false, 'joined late: not played out of time');
  let plays = 0; const o = { userData: { at: [1, 2], clipAt: null, action: { reset() {}, play() { plays++; }, paused: true }, mixer: { update() {} } } };
  for (let i = 0; i <= 8 * 24; i++) updateProps([o], (i / 24) % 4, 1 / 24);
  assert.equal(plays, 4, 'two puffs on each of two passes'); assert.equal(o.userData.action.paused, false);
  const at = propAttachments({ props: [{ prop: 'party_horn', file: 'h.glb', clips: { 'party-horn-toot': { standard: { bone: 'rightHand', position: [0, 0, 0], rotation: [0, 0, 0], prop_anim: { name: 'unroll', at: [1, 2] } } },
    x: { standard: { bone: 'rightHand', position: [0, 0, 0], rotation: [0, 0, 0], prop_anim: { name: 'unroll', at: ['a'] } } } } }] });
  assert.deepEqual(at.get('party-horn-toot')[0].prop_anim, { name: 'unroll', at: [1, 2] }); assert.deepEqual(at.get('x')[0].prop_anim, { name: 'unroll' });
});
