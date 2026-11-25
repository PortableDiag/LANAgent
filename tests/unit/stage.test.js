// The stage: what a program that draws the body may read (Gapless, 2119 #635).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { createStageRouter, stageAllowed } from '../../src/interfaces/web/stage.js';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const KEY = 'k'.repeat(64);

function rig({ id = 'store-linked-lnk-1-rose-base', body = 'female' } = {}) {
  PluginSettings.getCached = async () => null; PluginSettings.setCached = async () => {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  const p = new BotsAndBorgsPlugin({ interfaces: new Map(), agentModel: { activeVRMModel: id } }); p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  p.vrmDir = () => dir; p.libraryDir = () => path.join(dir, 'lib');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{ id, file: 'b.vrm' }])); fs.writeFileSync(path.join(dir, 'b.vrm'), 'the body');
  fs.mkdirSync(path.join(dir, 'animations/store/pack'), { recursive: true });
  const f = (name, label, x = {}) => { fs.writeFileSync(path.join(dir, 'animations/store/pack', name), `clip ${name}`); return { kind: 'animation', name, label, gesture: 'dance', loop: true, seconds: 4, ...x }; };
  const files = [f('Groove.vrma', 'Groove', { energy: 'high', faces: 'front' }), f('Groove-In.vrma', 'Groove In', { role: 'in' }), f('Pole-Dance.vrma', 'Pole Dance'), f('Dab.vrma', 'Dab', { loop: false }), f('Booty.vrma', 'Booty', { bodies: 'female' }), f('Maracas.vrma', 'Maracas Shake'), f('Wave.vrma', 'Wave', { gesture: 'wave' }), f('No.vrma', 'No')];
  p.libraryItems = async () => [{ variant: 'pack', files }]; p.bodyOf = async () => body; p.requiredProps = async () => new Map([['maracas.vrma', ['maraca']]]);
  p.clipsNotFor = async () => ({ reason: 'x', clips: new Set(['no']) }); p.fittedClips = async () => new Map(); p.ownedSets = async () => []; p.avatarLooks = async () => ({ [id]: { pieces: ['hair'] } });
  return { p, dir };
}

test('the state: the body worn, its look, and only the dances that suit it', async () => {
  const { p, dir } = rig(); const { state, files } = await p.stageState();
  assert.deepEqual(state.avatar, { sha256: sha('the body'), url: `/stage/v1/files/${sha('the body')}`, lent: true, expires: null }); assert.deepEqual(state.look, { pieces: ['hair'] });
  assert.deepEqual(state.dances.map(d => d.clip), ['booty', 'groove']); assert.equal(state.dances[1].energy, 0.9); assert.equal(state.dances[1].lent, undefined);
  assert.equal(state.set, null); assert.equal(state.choreography, null); assert.equal(files.size, 3);
  const male = rig({ body: 'male', id: 'store-vrm-x' }); const m = await male.p.stageState(); assert.deepEqual(m.state.dances.map(d => d.clip), ['groove']); assert.equal(m.state.avatar.lent, false);
  const own = path.join(dir, 'fitted.vrma'); fs.writeFileSync(own, 'fitted'); p.fittedClips = async () => new Map([['groove', own]]);
  const g = (await p.stageState()).state.dances.find(d => d.clip === 'groove'); assert.equal(g.sha256, sha('fitted')); assert.equal(g.lent, true);
  p.agent.agentModel.activeVRMModel = 'gone'; assert.equal(await p.stageState(), null);
});

test('only with the key, only what the state names, ETags; off with no key made', async () => {
  const { p, dir } = rig(); const keyFile = path.join(dir, 'key.sha256');
  assert.equal(await stageAllowed(`Bearer ${KEY}`, keyFile), false, 'no key was made');
  fs.writeFileSync(keyFile, `${sha(KEY)}\n`);
  const app = express(); app.use('/stage/v1', createStageRouter(null, { keyFile, store: () => p })); const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/stage/v1`;
  const H = { Authorization: `Bearer ${KEY}` };
  try {
    for (const h of [{}, { Authorization: 'Bearer wrong' }, { Authorization: `Bearer ${'x'.repeat(64)}` }, { 'X-API-Key': KEY }]) { assert.equal((await fetch(`${base}/state`, { headers: h })).status, 401); assert.equal((await fetch(`${base}/files/${sha('the body')}`, { headers: h })).status, 401); }
    const r = await fetch(`${base}/state`, { headers: H }); assert.equal(r.status, 200); const s = await r.json(); const tag = r.headers.get('etag');
    assert.equal((await fetch(`${base}/state`, { headers: { ...H, 'If-None-Match': tag } })).status, 304);
    const b = await fetch(base.replace('/stage/v1', '') + s.avatar.url, { headers: H }); assert.equal(sha(Buffer.from(await b.arrayBuffer())), s.avatar.sha256); assert.equal(b.headers.get('etag'), `"${s.avatar.sha256}"`); assert.equal(b.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(base.replace('/stage/v1', '') + s.avatar.url, { headers: { ...H, 'If-None-Match': `"${s.avatar.sha256}"` } })).status, 304);
    for (const bad of [sha('clip Pole-Dance.vrma'), '..%2Fmanifest.json', 'manifest.json']) assert.equal((await fetch(`${base}/files/${bad}`, { headers: H })).status, 404, bad);
    assert.equal((await fetch(`${base}/state`, { method: 'POST', headers: H })).status, 404, 'read only');
  } finally { srv.close(); srv.closeAllConnections?.(); }
});
