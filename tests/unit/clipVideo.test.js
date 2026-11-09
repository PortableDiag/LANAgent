// A video of the agent's 3D body doing a clip: the designer's own page code is used, the length rule, and the send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';
import { designerMethods, videoSeconds } from '../../src/services/avatar/clipVideo.js';

test("the renderer lifts the designer's own loader, retarget and pole fit from avatar.html", () => {
  const html = fs.readFileSync(new URL('../../src/interfaces/web/public/avatar.html', import.meta.url), 'utf8');
  const code = designerMethods(html);
  for (const name of ['_getBone(vrm, name) {', 'async loadVRMA(url) {', '_fitPoleSpot(vrm, clip) {']) assert.ok(code.includes(name), name);
  assert.ok(code.includes('VRMExpression') || code.includes('exprByNode'), 'face tracks come along');
  // The lifted text is valid as object members.
  assert.doesNotThrow(() => new Function(`return {\n${code}\n};`));
  assert.throws(() => designerMethods('<html></html>'), /has no _getBone/);
});

test('how long a video runs', () => {
  assert.equal(videoSeconds(38.4, true), 38.4, 'the pole dance plays once through');
  assert.equal(videoSeconds(4, true), 8, 'a short loop plays until about 6 s, whole loops');
  assert.equal(videoSeconds(2.2, false), 2.8, 'a one-shot plus a beat');
  assert.equal(videoSeconds(90, true), 40, 'capped');
  assert.equal(videoSeconds(9.6, true, { seconds: 5 }), 5);
});

function rig() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvid-')), vrm = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvid-'));
  fs.mkdirSync(path.join(vrm, 'animations'), { recursive: true });
  fs.writeFileSync(path.join(vrm, 'manifest.json'), JSON.stringify([{ id: 'store-racer', name: 'Racer Blue', file: 'store-racer.vrm' }]));
  fs.writeFileSync(path.join(vrm, 'animations', 'store.json'), JSON.stringify([{ file: 'store/pole/Pole-Dance.vrma', label: 'Pole Dance', loop: true, prop: { type: 'pole', x: -0.4, z: 0 } }]));
  const store = { library: { items: [{ variant: 'pole', title: 'VRM Pole Dance', kind: 'animation', files: [
    { name: 'Pole-Dance.vrma', kind: 'animation', label: 'Pole Dance', gesture: 'dance', loop: true },
    { name: 'Dance.vrma', kind: 'animation', label: 'Dance', gesture: 'dance', loop: true }] }] } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  const videos = [];
  const tg = { authorizedUserId: 7, sendNotification: async () => {}, bot: { telegram: { sendVideo: async (chat, file, extra) => videos.push({ chat, file, extra }) } } };
  const p = new BotsAndBorgsPlugin({ config: { name: 'ALICE' }, agentModel: { activeVRMModel: 'store-racer' }, interfaces: new Map([['telegram', tg]]), providerManager: {} });
  p.libraryRoot = lib; p.vrmRoot = vrm;
  const renders = [];
  p.renderVideo = async (o) => { renders.push(o); return { video: Buffer.from('mp4'), seconds: 38.4, width: 720, height: 960, bytes: 3 }; };
  return { p, videos, renders, store };
}

test('"send me a video of you doing the pole dance": the pole dance, on the worn model, with its pole, to the owner on Telegram', async () => {
  const { p, videos, renders } = rig();
  const r = await p.execute({ action: 'use', wait: true, _context: { originalInput: 'send me a video of you doing the pole dance' } });
  assert.equal(r.success, true, r.error);
  assert.equal(r.clip, 'Pole Dance');
  assert.match(r.result, /Sent you a 38-second video of me doing Pole Dance/);
  assert.match(renders[0].modelPath, /store-racer\.vrm$/);
  assert.match(renders[0].clipPath, /animations\/store\/pole\/Pole-Dance\.vrma$/);
  assert.equal(renders[0].loop, true);
  assert.deepEqual(renders[0].prop, { type: 'pole', x: -0.4, z: 0 });
  assert.equal(videos[0].chat, 7);
  assert.equal(videos[0].file.filename, 'pole-dance.mp4');
  assert.equal(videos[0].extra.supports_streaming, true);
});

test('without waiting, the answer comes at once and the video follows; no worn model is a plain no', async () => {
  const { p, videos } = rig();
  const r = await p.execute({ action: 'use', as: 'video', clip: 'pole dance' });
  assert.match(r.result, /Filming me doing Pole Dance; I'll send you the video/);
  await new Promise(res => setTimeout(res, 20));
  assert.equal(videos.length, 1);
  p.agent.agentModel.activeVRMModel = null;
  assert.match((await p.execute({ action: 'use', as: 'video', clip: 'pole dance' })).error, /not wearing a 3D model/);
});

test('"do the pole dance" (no video) still plays it, and a failed render tells the owner', async () => {
  const { p } = rig();
  const told = [];
  p.agent.interfaces.get('telegram').sendNotification = async (t) => told.push(t);
  p.renderVideo = async () => { throw new Error('ffmpeg: exit 1'); };
  const r = await p.execute({ action: 'use', wait: true, _context: { originalInput: 'film yourself doing the pole dance' } });
  assert.match(r.error, /The video of Pole Dance failed: ffmpeg: exit 1/);
  await p.execute({ action: 'use', _context: { originalInput: 'send me a video of you dancing the pole dance' } });
  await new Promise(res => setTimeout(res, 20));
  assert.match(told[0], /video of Pole Dance didn't work/);
  const play = await p.execute({ action: 'use', _context: { originalInput: 'do the pole dance' } });
  assert.equal(play.clip, 'Pole Dance');
  assert.doesNotMatch(play.result || '', /video/i);
});
