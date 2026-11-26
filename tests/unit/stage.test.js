// The stage: what a program that draws the body may read (Gapless, 2119 #635).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { createStageRouter, stageAllowed, startStageTls } from '../../src/interfaces/web/stage.js';
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
  assert.equal(state.set, null); assert.equal(state.choreography, null); assert.equal(files.size, 3); assert.deepEqual(state.sets, []);
  fs.writeFileSync(path.join(dir, 'b.jpg'), 'a beach'); fs.writeFileSync(path.join(dir, 'r.glb'), 'a room');
  p.ownedSets = async () => [{ spec: { id: 'beach', title: 'Sunset Beach 360', kind: 'equirect', file: 'b.jpg' }, mediaPath: path.join(dir, 'b.jpg') }, { spec: { id: 'attic', title: 'Attic Loft', kind: 'mesh', file: 'r.glb' }, mediaPath: path.join(dir, 'r.glb') }];
  const w = await p.stageState();
  assert.deepEqual(w.state.sets.map(x => [x.id, x.kind, x.bytes, x.lent, x.sha256 === sha(x.id === 'beach' ? 'a beach' : 'a room'), x.url.endsWith(x.sha256), x.spec.id]), [['attic', 'glb', 6, false, true, true, 'attic'], ['beach', '360', 7, false, true, true, 'beach']]);
  assert.equal(w.files.get(sha('a room')), path.join(dir, 'r.glb'));
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

test('over its own TLS port; plain http only from this machine; no certificate, no port', async () => {
  const { execFileSync } = await import('node:child_process'); const https = (await import('node:https')).default;
  const { p, dir } = rig(); const keyFile = path.join(dir, 'key.sha256'); fs.writeFileSync(keyFile, sha(KEY));
  assert.equal(await startStageTls(null, { dir, port: 0 }), null);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'tls-key.pem'), '-out', path.join(dir, 'tls-cert.pem'), '-days', '2', '-subj', '/CN=stage'], { stdio: 'ignore' });
  const srv = await startStageTls(null, { dir, port: 0, keyFile, store: () => p });
  const get = (headers) => new Promise((res, rej) => https.get({ port: srv.address().port, path: '/stage/v1/state', headers, rejectUnauthorized: false }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); }).on('error', rej));
  try { assert.equal(await get({ Authorization: `Bearer ${KEY}` }), 200); assert.equal(await get({}), 401); } finally { srv.close(); srv.closeAllConnections?.(); }
  const router = createStageRouter(null, { keyFile, store: () => p }); const mw = router.stack[0].handle; const ask = async (socket) => { let code = 0, passed = false; await mw({ socket, headers: { authorization: `Bearer ${KEY}` } }, { setHeader() {}, status(c) { code = c; return { json() {} }; } }, () => { passed = true; }); return passed || code; };
  assert.equal(await ask({ remoteAddress: '192.0.2.7' }), 403); assert.equal(await ask({ remoteAddress: '::ffff:127.0.0.1' }), true); assert.equal(await ask({ remoteAddress: '192.0.2.7', encrypted: true }), true);
});

test('pairing Lull: a key of its own beside the others, the link Lull 1.20 reads', async () => {
  const { lullPairing, LULL_PAIR } = await import('../../src/interfaces/web/stage.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-lull-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'tls-key.pem'), '-out', path.join(dir, 'tls-cert.pem'), '-days', '2', '-subj', '/CN=stage'], { stdio: 'ignore' });
  const file = path.join(dir, 'key.sha256');
  fs.writeFileSync(file, sha(KEY) + '\n');
  const first = await lullPairing({ name: 'ALICE', dir, url: 'https://10.0.0.5:8796' });
  const m = /^lull-stage:https:\/\/10\.0\.0\.5:8796#name=alice&key=([^&]+)&pin=([0-9a-f]{64})$/.exec(first.link);
  assert.ok(m, first.link);
  const pin = crypto.createHash('sha256').update(new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'tls-cert.pem'))).raw).digest('hex');
  assert.equal(m[2], pin);
  const key1 = decodeURIComponent(m[1]);
  assert.equal(first.linkHttps, `https://updates.procomputation.com/lull/pair#name=alice&key=${m[1]}&url=${encodeURIComponent('https://10.0.0.5:8796')}&pin=${pin}`);
  assert.equal(await stageAllowed(`Bearer ${key1}`, file), true, 'Lull in');
  assert.equal(await stageAllowed(`Bearer ${KEY}`, file), true, 'Gapless still in');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(key1), 'only the hash is kept');
  const second = await lullPairing({ name: 'ALICE', dir, url: 'https://10.0.0.5:8796' });
  const key2 = decodeURIComponent(/key=([^&]+)/.exec(second.link)[1]);
  assert.equal(await stageAllowed(`Bearer ${key1}`, file), false, 'the old Lull code stops');
  assert.equal(await stageAllowed(`Bearer ${key2}`, file), true);
  assert.equal(await stageAllowed(`Bearer ${KEY}`, file), true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  for (const s of ['pair with Lull', 'can you pair alice to lull', 'give me your Lull QR code', 'dance in Lull', 'connect to the lull app', 'lull pairing code please']) assert.ok(LULL_PAIR.test(s), s);
  for (const s of ['there was a lull in the music', 'play something calm']) assert.ok(!LULL_PAIR.test(s), s);
});
