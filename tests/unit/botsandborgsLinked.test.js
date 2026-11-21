// Store 0.51 linked agents + per-contact avatars (llms.txt "Linked agents"; 2119 #564-#571): someone's own avatars,
// read-only, fetched by sha256 ETag, roles the owner picked, copies deleted when the link ends, contacts by opaque key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';
import { linkedVariant, linkedModelId, linkedPrefix, contactKey, agentLinks, linkOutfits, readChoice, lockerRef, linkEnded } from '../../src/services/store/linkedAgents.js';

function glb(json) {
  const body = Buffer.from(JSON.stringify(json));
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + body.length, 8);
  head.writeUInt32LE(body.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, body]);
}
const vrm = (name) => glb({ extensions: { VRMC_vrm: { meta: { name }, humanoid: { humanBones: { hips: {}, head: {} } }, expressions: { preset: { happy: {} } } } } });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('names, keys and the store\'s answers', () => {
  assert.equal(linkedVariant('lnk_AB1', 'Rose Neon', 'Winter Coat'), 'linked-lnk-ab1-rose-neon-winter-coat');
  assert.equal(linkedModelId('lnk_1', 'rose', 'base'), 'store-linked-lnk-1-rose-base');
  assert.ok(linkedModelId('lnk_1', 'rose', 'base').startsWith(linkedPrefix('lnk_1')));
  const k = contactKey('6a95b0789dbae28518d04763', 'secret-a');
  assert.match(k, /^[A-Za-z0-9._:~-]{1,64}$/);
  assert.notEqual(k, contactKey('6a95b0789dbae28518d04763', 'secret-b'), 'two agents never share a key for one person');
  assert.ok(!k.includes('6a95b0789dbae28518d04763'));
  assert.deepEqual(agentLinks({ as_agent: [{ id: 'lnk_1', status: 'active', owner_name: 'Pat' }] }), [{ id: 'lnk_1', status: 'active', owner: 'Pat' }]);
  const outs = linkOutfits({ models: [{ id: 'rose', name: 'Rose', personal_license: true, outfits: [{ id: 'base', sha256: 'AB', looks: [{ id: 'lk1', name: 'Winter' }] }, { id: 'coat', name: 'Coat', sha256: 'cd' }] }] });
  assert.deepEqual(outs.map(o => [o.model, o.outfit, o.name, o.sha256, o.personalLicense]), [['rose', 'base', 'Rose', 'ab', true], ['rose', 'coat', 'Rose — Coat', 'cd', true]]);
  assert.deepEqual(readChoice({ ref: 'locker:rose/coat#lk1' }), { model: 'rose', outfit: 'coat', look: 'lk1', fallback: null });
  assert.equal(readChoice({ avatar: { model: 'rose', outfit: 'base' }, fallback_from: 'public' }).fallback, 'public');
  assert.equal(readChoice({}), null);
  assert.equal(lockerRef('rose', 'coat', 'lk1'), 'locker:rose/coat#lk1');
  assert.equal(linkEnded({ status: 403, code: 'link_ended' }), true);
  assert.equal(linkEnded({ status: 403, code: 'forbidden' }), false);
});

function rig({ routes = {}, files = {}, worn = 'store-vrm-racer-blue-bundle' } = {}) {
  const store = { settings: { weeklyBudgetUsd: 10, avatarRoles: {} } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const told = [];
  const p = new BotsAndBorgsPlugin({ agentModel: { activeVRMModel: worn }, config: { name: 'ALICE' }, notify: async (t) => told.push(t) });
  p.vrmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-link-'));
  fs.writeFileSync(path.join(p.vrmRoot, 'manifest.json'), JSON.stringify([{ id: worn, file: `${worn}.vrm` }]));
  p.accountKey = async () => 'bnba_test';
  p.pushRolesToStore = async () => {};
  const worns = [];
  p.wearGalleryModel = async (id) => { worns.push(id); p.agent.agentModel.activeVRMModel = id; };
  const calls = [];
  p.api = async (method, route, opts = {}) => {
    calls.push({ method, route, body: opts.body });
    const h = routes[`${method} ${route.split('?')[0]}`];
    if (typeof h === 'function') return h(opts);
    if (h) return h;
    if (method === 'put') return { ok: true };
    throw Object.assign(new Error('no route'), { status: 404 });
  };
  const fetched = [];
  p.http = async (req) => {
    fetched.push({ url: req.url, etag: req.headers['If-None-Match'] || null });
    const name = decodeURIComponent(req.url.split('/files/')[1] || '');
    const f = files[name];
    if (f === 403) return { status: 403, data: Buffer.from(JSON.stringify({ code: 'link_ended' })) };
    if (!f) return { status: 404, data: Buffer.from('') };
    if (req.headers['If-None-Match'] === `"${sha(f)}"`) return { status: 304, data: Buffer.from('') };
    return { status: 200, data: f };
  };
  return { p, store, calls, fetched, told, worns };
}

test('an approved link: outfits installed by sha256, the owner\'s picks applied, a fallback is not a pick', async () => {
  const base = vrm('Rose'); const coat = vrm('Rose coat');
  const t = rig({
    files: { 'rose/base': base, 'rose/coat': coat },
    routes: {
      'get /api/account/links': { as_agent: [{ id: 'lnk_1', status: 'active', owner_name: 'Pat' }] },
      'get /api/account/links/lnk_1': { models: [{ id: 'rose', name: 'Rose', outfits: [{ id: 'base', sha256: sha(base) }, { id: 'coat', name: 'Coat', sha256: sha(coat) }] }] },
      'get /api/account/links/lnk_1/roles/public': { avatar: { model: 'rose', outfit: 'base' } },
      'get /api/account/links/lnk_1/roles/assistant': { avatar: { model: 'rose', outfit: 'base' }, fallback_from: 'public' },
      'get /api/account/links/lnk_1/roles/personal': { ref: 'locker:rose/coat' }
    }
  });
  const r = await t.p.linkCommand({});
  assert.equal(r.success, true, r.error);
  const manifest = JSON.parse(fs.readFileSync(path.join(t.p.vrmRoot, 'manifest.json'), 'utf8'));
  assert.ok(manifest.some(m => m.id === 'store-linked-lnk-1-rose-base'));
  assert.ok(manifest.some(m => m.id === 'store-linked-lnk-1-rose-coat'));
  assert.equal(t.store.settings.avatarRoles.public, 'store-linked-lnk-1-rose-base');
  assert.ok(!t.store.settings.avatarRoles.assistant, 'a fallback answer is not the owner\'s pick');
  assert.deepEqual(t.worns, ['store-linked-lnk-1-rose-coat']);
  assert.equal(t.store.links.wornBefore, 'store-vrm-racer-blue-bundle');
  assert.match(r.result, /Pat: Rose, Rose — Coat; roles public = Rose, personal = Rose — Coat/);
  // A second sync sends the sha256 as the ETag and gets 304s: nothing downloaded again.
  t.fetched.length = 0;
  await t.p.syncLinks();
  assert.equal(t.fetched.length, 0, 'unchanged outfits are not fetched at all');
});

test('a file that is not the listed sha256 is refused; nothing is installed', async () => {
  const t = rig({
    files: { 'rose/base': vrm('Other') },
    routes: {
      'get /api/account/links': { as_agent: [{ id: 'lnk_2', status: 'active' }] },
      'get /api/account/links/lnk_2': { models: [{ id: 'rose', outfits: [{ id: 'base', sha256: 'f'.repeat(64) }] }] }
    }
  });
  await t.p.syncLinks();
  const manifest = JSON.parse(fs.readFileSync(path.join(t.p.vrmRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.some(m => /linked/.test(m.id)), false);
});

test('an ended link deletes every copy, clears its roles and wears the old model again; the owner is told', async () => {
  const base = vrm('Rose');
  let ended = false;
  const t = rig({
    files: { 'rose/base': base },
    routes: {
      'get /api/account/links': () => ({ as_agent: ended ? [] : [{ id: 'lnk_3', status: 'active', owner_name: 'Pat' }] }),
      'get /api/account/links/lnk_3': { models: [{ id: 'rose', name: 'Rose', outfits: [{ id: 'base', sha256: sha(base) }] }] },
      'get /api/account/links/lnk_3/roles/public': { ref: 'locker:rose/base' },
      'get /api/account/links/lnk_3/roles/personal': { ref: 'locker:rose/base' }
    }
  });
  await t.p.syncLinks();
  assert.equal(t.p.agent.agentModel.activeVRMModel, 'store-linked-lnk-3-rose-base');
  ended = true;
  await t.p.syncLinks();
  const manifest = JSON.parse(fs.readFileSync(path.join(t.p.vrmRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.some(m => /linked/.test(m.id)), false);
  assert.equal(fs.existsSync(path.join(t.p.vrmRoot, 'store-linked-lnk-3-rose-base.vrm')), false);
  assert.equal(t.store.settings.avatarRoles.public, null);
  assert.equal(t.p.agent.agentModel.activeVRMModel, 'store-vrm-racer-blue-bundle');
  assert.match(t.told.at(-1), /link to Pat has ended.*deleted my copies.*went back to my own/);
  assert.equal(t.store.links.links.length, 0);
});

test('a request takes only the email given; a pending link waits', async () => {
  const t = rig({ routes: { 'post /api/account/links/request': { ok: true } } });
  assert.match((await t.p.linkCommand({ request: 'not an email' })).error, /Which email/);
  assert.equal(t.calls.length, 0);
  const r = await t.p.linkCommand({ request: 'pat@example.com' });
  assert.equal(r.success, true);
  assert.deepEqual(t.calls[0].body.owner_email, 'pat@example.com');
  assert.equal(t.calls[0].body.name, 'ALICE');
});

test('per-contact avatars: set by name with our opaque key and a label, read back for that person only', async () => {
  const base = vrm('Rose');
  const t = rig({
    files: { 'rose/base': base },
    routes: {
      'get /api/account/links': { as_agent: [{ id: 'lnk_4', status: 'active' }] },
      'get /api/account/links/lnk_4': { models: [{ id: 'rose', name: 'Rose', outfits: [{ id: 'base', sha256: sha(base), looks: [{ id: 'lk9', name: 'Winter' }] }] }] }
    }
  });
  await t.p.syncLinks();
  const { PersonDirectory, memoryPeopleStore } = await import('../../src/services/people/personDirectory.js');
  const dir = new PersonDirectory({ store: memoryPeopleStore(), logger: { info() {}, warn() {} } });
  const wayne = await dir.resolve({ number: '+15551230000', email: 'wayne@example.com' }, { name: 'Wayne' });
  t.p._people = dir;
  const r = await t.p.setContactLook({ contact: 'Wayne', look: 'the winter look', key: 'bnba_test' });
  assert.equal(r.success, true, r.error);
  const put = t.calls.find(c => c.method === 'put');
  const ck = await t.p.contactKeyFor(wayne._id);
  assert.equal(put.route, `/api/account/links/lnk_4/contacts/${ck}`);
  assert.deepEqual(put.body, { label: 'Wayne', ref: 'locker:rose/base#lk9' });
  // Nothing sent carries his number, email or our Person id.
  const sent = JSON.stringify(t.calls);
  assert.ok(!/5551230000|wayne@example\.com/.test(sent));
  assert.ok(!sent.includes(String(wayne._id)));
  // "Suggest" waits for the owner.
  await t.p.setContactLook({ contact: 'Wayne', look: 'winter', propose: true, key: 'bnba_test' });
  assert.equal(t.calls.filter(c => c.method === 'put').at(-1).body.propose, true);
  assert.match((await t.p.setContactLook({ contact: 'Nobody', look: 'winter', key: 'k' })).error, /don't know anyone called Nobody/);
  // Read back: that person's pick is used; another person (404) falls to the roles.
  t.calls.length = 0;
  t.p.api = async (method, route) => {
    if (route === `/api/account/links/lnk_4/contacts/${ck}/avatar`) return { ref: 'locker:rose/base#lk9' };
    if (/\/contacts\/.+\/avatar$/.test(route)) return { avatar: { model: 'rose', outfit: 'base' }, fallback_from: 'assistant' };
    throw Object.assign(new Error('no route'), { status: 404 });
  };
  assert.equal(await t.p.contactModel(wayne._id), 'store-linked-lnk-4-rose-base');
  assert.equal(await t.p.contactModel('someone-else'), null, 'a fallback answer means the roles decide');
});
