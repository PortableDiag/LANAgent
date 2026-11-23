// AvatarX is an extra body for the agent: the agent pushes which VRM it wears, reusing an entry it already uploaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pushModelToAvatarX, pushBlockedToAvatarX, setBlockedSource, blockedEntry } from '../../src/services/avatar/avatarx.js';

function rig(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatarx-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{ id: 'store-x', name: 'Racer', file: 'x.vrm' }]));
  fs.writeFileSync(path.join(dir, 'x.vrm'), 'vrm-bytes');
  const keyFile = path.join(dir, 'key');
  fs.writeFileSync(keyFile, 'secret\n');
  const calls = [];
  const fetchFn = async (url, o) => {
    calls.push({ url, method: o.method, auth: o.headers.Authorization, body: o.body });
    const json = o.method === 'GET' ? state : o.method === 'POST' ? { avatar: { id: 'new1' } } : {};
    return { ok: true, status: 200, json: async () => json };
  };
  return { opts: { url: 'http://127.0.0.1:8795/', keyFile, vrmDir: dir, fetchFn }, calls };
}

test('not set up: does nothing', async () => {
  assert.equal(await pushModelToAvatarX('store-x', { url: '', keyFile: '' }), 'not connected');
});

test('a new model is uploaded, then made active', async () => {
  const { opts, calls } = rig({ avatars: [] });
  assert.equal(await pushModelToAvatarX('store-x', opts), 'updated');
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST', 'PATCH']);
  assert.equal(calls[0].auth, 'Bearer secret');
  assert.match(calls[1].url, /\/agent\/v1\/avatars\?name=Racer$/);
  assert.equal(calls[1].body.toString(), 'vrm-bytes');
  assert.deepEqual(JSON.parse(calls[2].body), { active: 'new1' });
});

test('a model already there is reused, because uploads pile up', async () => {
  const { opts, calls } = rig({ avatars: [{ id: 'old7', name: 'Racer' }] });
  await pushModelToAvatarX('store-x', opts);
  assert.deepEqual(calls.map(c => c.method), ['GET', 'PATCH']);
  assert.deepEqual(JSON.parse(calls[1].body), { active: 'old7' });
});

test('a fixed file under the same name goes up and is shown; the same file shown already changes nothing', async () => {
  // 'vrm-bytes' is 9 bytes: a 12-byte copy named Racer is an older file (the store re-published it).
  const changed = rig({ active: 'old7', avatars: [{ id: 'old7', name: 'Racer', size: 12 }] });
  assert.equal(await pushModelToAvatarX('store-x', changed.opts), 'updated');
  assert.deepEqual(changed.calls.map(c => c.method), ['GET', 'POST', 'PATCH']);
  assert.deepEqual(JSON.parse(changed.calls[2].body), { active: 'new1' });
  const same = rig({ active: 'old7', avatars: [{ id: 'old7', name: 'Racer', size: 9 }] });
  assert.equal(await pushModelToAvatarX('store-x', same.opts), 'unchanged');
  assert.deepEqual(same.calls.map(c => c.method), ['GET']);
});

test('an unknown model and a refusal are reported', async () => {
  const { opts } = rig({ avatars: [] });
  await assert.rejects(() => pushModelToAvatarX('nope', opts), /not in the gallery/);
  await assert.rejects(() => pushModelToAvatarX('store-x', { ...opts, fetchFn: async () => ({ ok: false, status: 403 }) }), /403/);
});

// AvatarX 0.4.14: the clips the store says a body must not play are refused by AvatarX's own buttons too.
test('blocked clips: sent before the body shows, once, lifted with null; an older AvatarX changes nothing else', async () => {
  assert.equal(blockedEntry(null), null);
  assert.deepEqual(blockedEntry({ reason: 'no dancing', clips: new Set(['roger-rabbit', 'clap-2']) }).clips.filter(c => /^(roger-rabbit|clap_2)$/.test(c)), ['roger-rabbit', 'clap_2']);
  let not = { reason: 'no dancing', clips: new Set(['rumba']) };
  setBlockedSource(async (id) => (id === 'store-x' ? not : null));
  try {
    const t = rig({ avatars: [{ id: 'blk1', name: 'Racer', size: 9 }] });
    await pushModelToAvatarX('store-x', t.opts);
    assert.deepEqual(t.calls.map(c => c.body && JSON.parse(c.body)).filter(Boolean), [{ blocked: { blk1: { clips: ['rumba'], reason: 'no dancing' } } }, { active: 'blk1' }]);
    await pushBlockedToAvatarX('store-x', t.opts);
    assert.equal(t.calls.filter(c => /blocked/.test(c.body || '')).length, 1, 'the same list is not sent twice');
    not = null;
    assert.equal(await pushBlockedToAvatarX('store-x', t.opts), 'blk1');
    assert.deepEqual(JSON.parse(t.calls.at(-1).body), { blocked: { blk1: null } });
    const plain = rig({ avatars: [{ id: 'never', name: 'Racer', size: 9 }] });
    await pushModelToAvatarX('store-x', plain.opts);
    assert.ok(!plain.calls.some(c => /blocked/.test(c.body || '')), 'nothing to block and nothing to lift: not sent');
    not = { reason: 'r', clips: ['rumba'] };
    const old = rig({ avatars: [{ id: 'old1', name: 'Racer', size: 9 }] });
    const inner = old.opts.fetchFn;
    old.opts.fetchFn = async (u, o) => (/blocked/.test(o.body || '') ? { ok: false, status: 400, json: async () => ({}) } : inner(u, o));
    assert.equal(await pushModelToAvatarX('store-x', old.opts), 'updated');
  } finally { setBlockedSource(null); }
});
