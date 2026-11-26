// The moving parts of a set (bnb-set/1 loops, 3910 #6035).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goodLoop, framesAt, pulseAt, swayAt, applyLoops } from '../../src/interfaces/web/public/lib/bnb-loops.js';

const frames = { node: 'screen', type: 'frames', count: 8, fps: 12, cols: 4, du: 0.25, dv: 0.125 };
test('frames: whole frames, in rows, looping; no frame is missed or shown twice at the film rate', () => {
  assert.deepEqual(framesAt(frames, 0), [0, 0]); assert.deepEqual(framesAt(frames, 1 / 12), [0.25, 0]); assert.deepEqual(framesAt(frames, 4 / 12), [0, 0.125]); assert.deepEqual(framesAt(frames, 7 / 12), [0.75, 0.125]); assert.deepEqual(framesAt(frames, 8 / 12), [0, 0]);
  for (let i = 0; i < 240; i++) { const k = Math.floor(i / 2) % 8; assert.deepEqual(framesAt(frames, i / 24), [(k % 4) * 0.25, Math.floor(k / 4) * 0.125], String(i)); }
});

test('pulse and sway are where the formula says', () => {
  const p = { node: 'n', type: 'pulse', min: 0.5, max: 1, period_s: 2, phase: 0 };
  assert.equal(pulseAt(p, 0), 0.5); assert.ok(Math.abs(pulseAt(p, 1) - 1) < 1e-9); assert.ok(Math.abs(pulseAt({ ...p, phase: 0.5 }, 0) - 1) < 1e-9);
  const s = { node: 'n', type: 'sway', axis: [1, 0, 0], amount_m: 0.2, period_s: 4, phase: 0 };
  assert.ok(Math.abs(swayAt(s, 1)[0] - 0.2) < 1e-9); assert.equal(swayAt(s, 0)[0], 0);
});

test('anything out of the format stays still', () => {
  assert.ok(goodLoop(frames));
  for (const bad of [null, {}, { ...frames, count: 1 }, { ...frames, fps: 30 }, { ...frames, cols: 0 }, { ...frames, node: '' }, { node: 'n', type: 'pulse', min: 0, max: 1, period_s: 0.1 }, { node: 'n', type: 'pulse', min: 0, max: 9, period_s: 1 }, { node: 'n', type: 'sway', axis: [1, 0], amount_m: 0.1, period_s: 1 }, { node: 'n', type: 'sway', axis: [1, 0, 0], amount_m: 2, period_s: 1 }, { node: 'n', type: 'spin' }]) assert.equal(goodLoop(bad), false, JSON.stringify(bad));
});

function node(name, map = true) {
  const vec = (x, y) => ({ x, y, set(a, b) { this.x = a; this.y = b; } });
  const tex = () => ({ offset: vec(0, 0), clone() { return tex(); } });
  const mat = (m) => ({ userData: {}, map: m, color: { r: 1, g: 0.5, b: 0, setRGB(r, g, b) { Object.assign(this, { r, g, b }); } }, clone() { const c = mat(this.map); return c; } });
  const shared = mat(map ? tex() : null);
  const n = { name, isMesh: true, material: shared, shared, position: { x: 1, y: 2, z: 3, clone() { return { x: this.x, y: this.y, z: this.z }; }, set(x, y, z) { Object.assign(this, { x, y, z }); } }, traverse(f) { f(this); } };
  return n;
}
test('applied: each node gets its own material, the shared one is left alone; a missing node and a seventeenth loop are not played', () => {
  const a = node('screen'), b = node('stick'); const root = { getObjectByName: (n) => ({ screen: a, stick: b })[n] };
  const l = applyLoops(root, [frames, { node: 'screen', type: 'pulse', min: 0.5, max: 1, period_s: 2 }, { node: 'stick', type: 'sway', axis: [0, 1, 0], amount_m: 0.1, period_s: 4 }, { ...frames, node: 'gone' }, { node: 'stick', type: 'spin' }]);
  assert.equal(l.count, 3); l.at(1 / 12); assert.equal(a.material.map.offset.x, 0.25); assert.equal(a.shared.map.offset.x, 0); assert.notEqual(a.material, a.shared);
  l.at(0); assert.equal(a.material.color.r, 0.5); assert.equal(a.shared.color.r, 1); l.at(1); assert.ok(Math.abs(a.material.color.r - 1) < 1e-9, 'never multiplied onto the last frame'); assert.ok(Math.abs(b.position.y - 2.1) < 1e-9);
  assert.equal(applyLoops(root, Array.from({ length: 20 }, () => ({ node: 'stick', type: 'sway', axis: [0, 1, 0], amount_m: 0.1, period_s: 4 }))).count, 16);
  assert.equal(applyLoops(root, undefined).count, 0);
});

test('swing: a turn about a pivot, with a sway after it; out of range stays still; one a node (3910 #6275)', async () => {
  const { swingAt, turnAbout, readyBeams } = await import('../../src/interfaces/web/public/lib/bnb-loops.js');
  const l = { node: 'beam', type: 'swing', pivot: [0, 3, 0], axis: [0, 0, 1], angle_deg: 20, period_s: 4, phase: 0 };
  assert.ok(goodLoop(l)); for (const bad of [{ ...l, angle_deg: 30 }, { ...l, angle_deg: 0 }, { ...l, axis: [0, 0, 2] }, { ...l, axis: [1, 0, 1] }, { ...l, period_s: 1 }, { ...l, pivot: [0, 0] }]) assert.equal(goodLoop(bad), false);
  assert.equal(swingAt(l, 0), 0); assert.ok(Math.abs(swingAt(l, 1) - 20 * Math.PI / 180) < 1e-9);
  const r = turnAbout([1, 3, 0], [0, 3, 0], [0, 0, 1], Math.PI / 2); assert.ok(Math.hypot(r[0], r[1] - 4, r[2]) < 1e-9);
  const vm = await import('node:vm'); const fsp = await import('node:fs');
  const ctx = { console, performance, self: {}, window: {}, document: {}, navigator: {} }; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fsp.readFileSync(new URL('../../src/interfaces/web/public/lib/three.r183.min.js', import.meta.url), 'utf8'), ctx);
  const THREE = ctx.THREE || ctx.self.THREE || ctx.window.THREE;
  const root = new THREE.Group(), scene = new THREE.Group(), holder = new THREE.Group(), beam = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ transparent: true }));
  beam.name = 'beam'; scene.position.set(5, 0, 0); holder.position.set(0, 1, 0); beam.position.set(0, 2, 0); root.add(scene); scene.add(holder); holder.add(beam);
  const a = applyLoops(root, [l, { ...l, pivot: [9, 9, 9] }, { node: 'beam', type: 'sway', axis: [1, 0, 0], amount_m: 0.1, period_s: 4 }]); assert.equal(a.count, 2, 'a second swing is not played');
  a.at(1); root.updateMatrixWorld(true);
  assert.ok(Math.abs(beam.position.x - 0.1) < 1e-9 && Math.abs(beam.position.y - 2) < 1e-9, 'hung at its pivot: turned in place, then moved');
  const tip = new THREE.Vector3(0, -2, 0).applyMatrix4(beam.matrixWorld); const want = turnAbout([0, 1, 0], [0, 3, 0], [0, 0, 1], 20 * Math.PI / 180); assert.ok(Math.hypot(tip.x - (5 + want[0] + 0.1), tip.y - want[1], tip.z - want[2]) < 1e-9, 'the far end is where the formula says, in the set');
  a.at(0); assert.ok(Math.abs(beam.quaternion.w - 1) < 1e-12, 'back at rest');
  assert.equal(readyBeams(root, ['beam', 'gone']), 1); assert.equal(beam.material.depthWrite, false); assert.equal(beam.renderOrder, 10); beam.material.transparent = false; assert.equal(readyBeams(root, ['beam']), 0);
});

test('16 loops and the swings of up to 8 beams besides (2119 #676)', async () => {
  const { applyLoops } = await import('../../src/interfaces/web/public/lib/bnb-loops.js');
  const nodes = new Map(); const mk = (name) => { const n = { name, position: { x: 0, y: 0, z: 0, clone() { return { ...this }; }, set(x, y, z) { Object.assign(this, { x, y, z }); } }, quaternion: { clone() { return { setFromAxisAngle() { return this; }, multiply() { return this; } }; }, copy() { return { multiply() {} }; } }, traverse(f) { f(this); } }; nodes.set(name, n); return n; };
  const root = { getObjectByName: (n) => nodes.get(n) || mk(n) };
  const sway = (i) => ({ node: `s${i}`, type: 'sway', axis: [0, 1, 0], amount_m: 0.1, period_s: 2 });
  const swing = (n) => ({ node: n, type: 'swing', pivot: [0, 3, 0], axis: [0, 0, 1], angle_deg: 10, period_s: 4 });
  const loops = [...Array.from({ length: 16 }, (_, i) => sway(i)), ...Array.from({ length: 9 }, (_, i) => swing(`b${i}`))];
  assert.equal(applyLoops(root, loops, Array.from({ length: 9 }, (_, i) => `b${i}`)).count, 24, '16 and 8 beams');
  assert.equal(applyLoops(root, loops, []).count, 16, 'not beams: 16 in all');
  assert.equal(applyLoops(root, [...Array.from({ length: 20 }, (_, i) => sway(i))], ['s0']).count, 16);
});
