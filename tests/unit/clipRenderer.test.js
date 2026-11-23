// The graphics chip for videos (2026-11-23), and the CPU when it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeArgs, onBestRenderer, hasGpu, _resetGpu, modelTriangles } from '../../src/services/avatar/clipVideo.js';

test('the chip is used when there is one; any failure falls back at once and rests the chip', async () => {
  _resetGpu(); const runs = []; let t = 1000;
  const opts = { available: () => true, now: () => t };
  assert.equal(await onBestRenderer('video', async (g) => { runs.push(g); return g ? 'gpu' : 'cpu'; }, opts), 'gpu');
  const fail = async (g) => { runs.push(g); if (g) throw new Error('lost context'); return 'cpu'; };
  assert.equal(await onBestRenderer('video', fail, opts), 'cpu'); assert.deepEqual(runs, [true, true, false]);
  t += 60000; assert.equal(await onBestRenderer('video', fail, opts), 'cpu'); assert.deepEqual(runs.slice(3), [false], 'rested');
  t += 31 * 60000; await onBestRenderer('video', fail, opts); assert.deepEqual(runs.slice(4), [true, false], 'tried again later');
  _resetGpu(); await assert.rejects(onBestRenderer('video', async () => { throw new Error('both'); }, opts), /both/);
  _resetGpu(); runs.length = 0; await onBestRenderer('video', async (g) => { runs.push(g); }, { available: () => false }); assert.deepEqual(runs, [false]);
});

test('flags and the switch', () => {
  assert.ok(chromeArgs(true, 1, 2).includes('--use-angle=gl-egl')); assert.ok(!chromeArgs(true, 1, 2).some(a => /swiftshader/.test(a)));
  assert.ok(chromeArgs(false, 1, 2).includes('--use-angle=swiftshader-webgl')); assert.ok(chromeArgs(false, 7, 8).includes('--window-size=7,8'));
  const was = process.env.CLIP_VIDEO_GPU; process.env.CLIP_VIDEO_GPU = 'off'; assert.equal(hasGpu(), false); process.env.CLIP_VIDEO_GPU = 'on'; assert.equal(hasGpu(), true);
  if (was === undefined) delete process.env.CLIP_VIDEO_GPU; else process.env.CLIP_VIDEO_GPU = was;
});

test("a model's triangles are read from its header; anything else is 0", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tri-')); const j = Buffer.from(JSON.stringify({ meshes: [{ primitives: [{ indices: 0, attributes: { POSITION: 1 } }, { attributes: { POSITION: 1 } }] }], accessors: [{ count: 900 }, { count: 300 }] }));
  const h = Buffer.alloc(20); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(20 + j.length, 8); h.writeUInt32LE(j.length, 12); h.write('JSON', 16);
  fs.writeFileSync(path.join(d, 'a.vrm'), Buffer.concat([h, j])); fs.writeFileSync(path.join(d, 'b.vrm'), 'nope');
  assert.equal(await modelTriangles(path.join(d, 'a.vrm')), 400); assert.equal(await modelTriangles(path.join(d, 'b.vrm')), 0); assert.equal(await modelTriangles(path.join(d, 'none.vrm')), 0);
});
