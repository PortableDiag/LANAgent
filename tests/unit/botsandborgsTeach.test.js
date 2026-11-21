// Store 0.59: teach a motion. Asked in words, followed to published, the free single comes through the library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

function plugin(routes) {
  const store = {};
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const p = new BotsAndBorgsPlugin({ agentModel: {} });
  p.accountKey = async () => 'bnba_k';
  const calls = [];
  p.api = async (method, route, opts = {}) => {
    calls.push({ method, route, body: opts.body });
    const h = routes[`${method} ${route}`];
    if (typeof h === 'function') return h();
    if (h) return h;
    throw Object.assign(new Error('no route'), { status: 404 });
  };
  const told = [];
  p.agent.notify = async (t) => told.push(t);
  let synced = 0;
  p.syncLibrary = async () => { synced++; return []; };
  return { p, store, calls, told, synced: () => synced };
}

test('a motion is asked for, followed through review to published, and its free single is fetched', async () => {
  let status = 'drafting';
  const t = plugin({
    'post /api/anim/teach': { teach: { id: 'tch_1', status: 'new' } },
    'get /api/anim/teach/tch_1': () => ({ teach: { id: 'tch_1', status, round: 1, ...(status === 'published' ? { result: { pack: 'vrm-taught-motions', single: 'vrm-taught-motions-slow-bow', clip: 'slow-bow' } } : {}) } })
  });
  const r = await t.p.teachCommand({ motion: 'a slow bow with the right hand on the chest', note: 'for greeting viewers' });
  assert.equal(r.success, true);
  assert.deepEqual(t.calls[0].body, { motion: 'a slow bow with the right hand on the chest', note: 'for greeting viewers' });
  await t.p.teachTick();
  assert.equal(t.told.length, 0, 'drafting: nothing to tell yet');
  status = 'review'; await t.p.teachTick();
  assert.match(t.told[0], /drafted "a slow bow/);
  status = 'published'; await t.p.teachTick();
  assert.match(t.told[1], /taught the motion "a slow bow.*\(slow-bow\)/);
  assert.equal(t.synced(), 1);
  await t.p.teachTick();
  assert.equal(t.told.length, 2, 'a finished one is not read again');
  assert.match((await t.p.teachCommand({ list: true })).result, /published, round 1.*now my clip "slow-bow"/);
});

test('three in progress: a plain answer, nothing saved', async () => {
  const t = plugin({ 'post /api/anim/teach': () => { throw Object.assign(new Error('too many'), { status: 429, code: 'too_many_open' }); } });
  const r = await t.p.teachCommand({ motion: 'a moonwalk' });
  assert.match(r.error, /already working on three motions/);
  assert.equal((await t.p.teachRequests()).length, 0);
});
