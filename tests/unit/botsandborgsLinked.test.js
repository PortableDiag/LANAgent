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
  assert.deepEqual(readChoice({ ref: 'locker:rose/coat#lk1' }), { model: 'rose', outfit: 'coat', look: 'lk1', settings: null, fallback: null });
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

test('the store\'s real example responses (2119 #572) read right', () => {
  const sha0 = '3f9a6c1e' + '0'.repeat(56);
  const detail = { link: { fallback: 'public', id: 'lnk_EXAMPLE', models: [{ model: 'mdl_EXAMPLE', name: 'Example Avatar', outfits: [{ bytes: 15863136, file: 'https://botsandborgs.com/api/account/links/lnk_EXAMPLE/files/mdl_EXAMPLE/base', label: 'Base', looks: [{ colors: { Body: { hue: 20, light: 1, sat: 1.1 } }, id: 'lk_EXAMPLE', morphs: { Smile: 0.4 }, name: 'Evening', pieces: null, ref: 'locker:mdl_EXAMPLE/base#lk_EXAMPLE' }], outfit: 'base', ready: true, ref: 'locker:mdl_EXAMPLE/base', sha256: sha0 }], personal_license: false }], owner: 'acct_OWNER', read_only: true, roles: { assistant: 'locker:mdl_EXAMPLE/base', public: 'locker:mdl_EXAMPLE/base#lk_EXAMPLE' }, status: 'active' } };
  const [o] = linkOutfits(detail);
  assert.deepEqual([o.model, o.outfit, o.name, o.sha256, o.looks[0].name, o.personalLicense], ['mdl_EXAMPLE', 'base', 'Example Avatar — Base', sha0, 'Evening', false]);
  assert.deepEqual(agentLinks({ as_agent: [{ id: 'lnk_EXAMPLE', owner: 'acct_OWNER', status: 'revoked' }], as_owner: [] }), [{ id: 'lnk_EXAMPLE', status: 'revoked', owner: 'acct_OWNER' }]);
  // A role that is a look: the look's settings carry no id; the ref does.
  assert.deepEqual(readChoice({ file: 'x', look: { colors: {}, morphs: { Smile: 0.4 }, pieces: null }, model: 'mdl_EXAMPLE', outfit: 'base', ref: 'locker:mdl_EXAMPLE/base#lk_EXAMPLE', role: 'public' }),
    { model: 'mdl_EXAMPLE', outfit: 'base', look: 'lk_EXAMPLE', settings: { colors: {}, morphs: { Smile: 0.4 }, pieces: null }, fallback: null });
  assert.equal(readChoice({ fallback_from: 'personal', model: 'mdl_EXAMPLE', outfit: 'base', ref: 'locker:mdl_EXAMPLE/base#lk_EXAMPLE', role: 'public' }).fallback, 'personal');
  assert.equal(readChoice({ contact: { key: 'p_unknown', label: null }, fallback_from: 'contact', model: 'mdl_EXAMPLE', outfit: 'base', ref: 'locker:mdl_EXAMPLE/base', role: 'assistant' }).fallback, 'contact');
});

test('an approved link: outfits installed by sha256, the owner\'s picks applied, a fallback is not a pick', async () => {
  const base = vrm('Rose'); const coat = vrm('Rose coat');
  const t = rig({
    files: { 'rose/base': base, 'rose/coat': coat },
    routes: {
      'get /api/account/links': { as_agent: [{ id: 'lnk_1', status: 'active', owner_name: 'Pat' }] },
      'get /api/account/links/lnk_1': { link: { id: 'lnk_1', models: [{ model: 'rose', name: 'Rose', outfits: [{ outfit: 'base', label: 'Rose', sha256: sha(base) }, { outfit: 'coat', label: 'Coat', sha256: sha(coat) }] }] } },
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
  const jo = await dir.resolve({ number: '+15551230000', email: 'jo@example.com' }, { name: 'Jo' });
  t.p._people = dir;
  const r = await t.p.setContactLook({ contact: 'Jo', look: 'the winter look', key: 'bnba_test' });
  assert.equal(r.success, true, r.error);
  const put = t.calls.find(c => c.method === 'put');
  const ck = await t.p.contactKeyFor(jo._id);
  assert.equal(put.route, `/api/account/links/lnk_4/contacts/${ck}`);
  assert.deepEqual(put.body, { label: 'Jo', ref: 'locker:rose/base#lk9' });
  // Nothing sent carries his number, email or our Person id.
  const sent = JSON.stringify(t.calls);
  assert.ok(!/5551230000|jo@example\.com/.test(sent));
  assert.ok(!sent.includes(String(jo._id)));
  // "Suggest" waits for the owner.
  await t.p.setContactLook({ contact: 'Jo', look: 'winter', propose: true, key: 'bnba_test' });
  assert.equal(t.calls.filter(c => c.method === 'put').at(-1).body.propose, true);
  assert.match((await t.p.setContactLook({ contact: 'Nobody', look: 'winter', key: 'k' })).error, /don't know anyone called Nobody/);
  // Read back: that person's pick is used; another person (404) falls to the roles.
  t.calls.length = 0;
  t.p.api = async (method, route) => {
    if (route === `/api/account/links/lnk_4/contacts/${ck}/avatar`) return { ref: 'locker:rose/base#lk9' };
    if (/\/contacts\/.+\/avatar$/.test(route)) return { avatar: { model: 'rose', outfit: 'base' }, fallback_from: 'assistant' };
    throw Object.assign(new Error('no route'), { status: 404 });
  };
  assert.deepEqual(await t.p.contactModel(jo._id), { modelId: 'store-linked-lnk-4-rose-base', look: { colors: {}, morphs: {}, pieces: null } });
  assert.equal(await t.p.contactModel('someone-else'), null, 'a fallback answer means the roles decide');
});

test('two syncs at once share one run: nothing is downloaded twice (2026-11-20, 5 GB twice)', async () => {
  const base = vrm('Rose');
  const t = rig({
    files: { 'rose/base': base },
    routes: {
      'get /api/account/links': { as_agent: [{ id: 'lnk_5', status: 'active' }] },
      'get /api/account/links/lnk_5': { link: { models: [{ model: 'rose', outfits: [{ outfit: 'base', sha256: sha(base) }] }] } }
    }
  });
  const [a, b] = await Promise.all([t.p.syncLinks(), t.p.syncLinks()]);
  assert.equal(a, b);
  assert.equal(t.fetched.length, 1);
});

test('AvatarX: a lent body is tagged with its link, and only those bodies come off at unlink', async () => {
  const { pushModelToAvatarX, removeLentAvatars } = await import('../../src/services/avatar/avatarx.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-'));
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, 'k');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{ id: 'store-linked-lnk-1-rose-base', name: 'Rose', file: 'r.vrm' }]));
  fs.writeFileSync(path.join(dir, 'r.vrm'), vrm('Rose'));
  const sent = [];
  const fetchFn = async (url, { method }) => {
    sent.push(`${method} ${url.replace('https://ax', '')}`);
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ avatars: [{ id: 'mine', name: 'Racer' }, { id: 'lent1', name: 'Rose', size: 1, link: 'lnk_1' }, { id: 'lent2', name: 'Other', link: 'lnk_2' }], active: 'mine' }) };
    if (method === 'POST') return { ok: true, status: 200, json: async () => ({ avatar: { id: 'lent9' } }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await pushModelToAvatarX('store-linked-lnk-1-rose-base', { url: 'https://ax', keyFile, vrmDir: dir, fetchFn, link: 'lnk_1' });
  assert.ok(sent.some(x => /^POST \/agent\/v1\/avatars\?name=Rose&link=lnk_1$/.test(x)), sent.join('\n'));
  sent.length = 0;
  const gone = await removeLentAvatars('lnk_1', { url: 'https://ax', keyFile, fetchFn });
  assert.deepEqual(gone, ['lent1']);
  assert.deepEqual(sent.filter(x => x.startsWith('DELETE')), ['DELETE /agent/v1/avatars/lent1']);
});

test('looks: a role pick that is a look is kept with its settings, worn on AvatarX and served to the 3D page', async () => {
  const base = vrm('Rose');
  const evening = { colors: { Body: { hue: 20, light: 1, sat: 1.1 } }, morphs: { Smile: 0.4 }, pieces: null };
  const t = rig({
    files: { 'rose/base': base },
    routes: {
      'get /api/account/links': { as_agent: [{ id: 'lnk_6', status: 'active' }] },
      'get /api/account/links/lnk_6': { link: { models: [{ model: 'rose', name: 'Rose', outfits: [{ outfit: 'base', label: 'Base', sha256: sha(base), looks: [{ id: 'lk_1', name: 'Evening', ...evening }] }] }] } },
      'get /api/account/links/lnk_6/roles/personal': { model: 'rose', outfit: 'base', look: evening, ref: 'locker:rose/base#lk_1', role: 'personal' },
      'get /api/account/links/lnk_6/roles/assistant': { model: 'rose', outfit: 'base', look: null, ref: 'locker:rose/base', role: 'assistant' }
    }
  });
  const wore = [];
  t.p.wearGalleryModel = async (id, look, link) => { wore.push({ id, look, link }); t.p.agent.agentModel.activeVRMModel = id; };
  await t.p.syncLinks();
  assert.deepEqual(wore, [{ id: 'store-linked-lnk-6-rose-base', look: evening, link: 'lnk_6' }]);
  assert.deepEqual(await t.p.avatarLooks(), { 'store-linked-lnk-6-rose-base': evening });
  // A video of the worn body wears the personal look; the assistant pick (same outfit, no look) has none of its own.
  const personal = await t.p.modelFor('personal');
  assert.deepEqual(personal.look, evening);
  const { publicState } = await import('../../src/services/avatar/liveAvatar.js');
  const st = publicState({ settings: {}, active: 'store-linked-lnk-6-rose-base', avatarList: [{ id: 'store-linked-lnk-6-rose-base', name: 'Rose', size: 1 }, { id: 'mine', name: 'Mine', size: 2 }], clipNames: [], propList: [], backgroundNames: [], looks: await t.p.avatarLooks() });
  assert.deepEqual(st.avatars[0].look, evening);
  assert.equal('look' in st.avatars[1], false);
});

test('looks: a contact\'s look comes with that person\'s video only', async () => {
  const base = vrm('Rose');
  const gym = { colors: {}, morphs: {}, pieces: ['Body', 'TankTop'] };
  const t = rig({
    files: { 'rose/base': base },
    routes: {
      'get /api/account/links': { as_agent: [{ id: 'lnk_7', status: 'active' }] },
      'get /api/account/links/lnk_7': { link: { models: [{ model: 'rose', outfits: [{ outfit: 'base', sha256: sha(base) }] }] } }
    }
  });
  await t.p.syncLinks();
  t.p.api = async (method, route) => {
    if (/\/contacts\/.+\/avatar$/.test(route)) return { contact: { key: 'x', label: 'Jo' }, model: 'rose', outfit: 'base', look: gym, ref: 'locker:rose/base#lk_g' };
    throw Object.assign(new Error('no route'), { status: 404 });
  };
  const m = await t.p.modelFor('assistant', { personId: 'p1' });
  assert.equal(m.id, 'store-linked-lnk-7-rose-base');
  assert.deepEqual(m.look, gym);
});

test('AvatarX: a lent body wearing a look gets it with PATCH looks; the page\'s own avatars never do', async () => {
  const { pushModelToAvatarX } = await import('../../src/services/avatar/avatarx.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-'));
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, 'k');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{ id: 'm1', name: 'Rose', file: 'r.vrm' }]));
  fs.writeFileSync(path.join(dir, 'r.vrm'), vrm('Rose'));
  const sent = [];
  const fetchFn = async (url, { method, body }) => {
    sent.push({ method, url: url.replace('https://ax', ''), body });
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ avatars: [], active: 'x' }) };
    if (method === 'POST') return { ok: true, status: 200, json: async () => ({ avatar: { id: 'lent9' } }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const look = { colors: { Body: { hue: 20 } }, morphs: {}, pieces: null };
  await pushModelToAvatarX('m1', { url: 'https://ax', keyFile, vrmDir: dir, fetchFn, link: 'lnk_1', look });
  const patches = sent.filter(x => x.method === 'PATCH').map(x => JSON.parse(x.body));
  assert.deepEqual(patches[0], { looks: { lent9: look } });
  assert.deepEqual(patches[1], { active: 'lent9' });
  sent.length = 0;
  await pushModelToAvatarX('m1', { url: 'https://ax', keyFile, vrmDir: dir, fetchFn, look });
  assert.equal(sent.filter(x => x.method === 'PATCH' && /looks/.test(x.body)).length, 0, 'no link, no look');
});

test('pictures follow linked picks: public and personal portraits rendered once, applied only on a change', async () => {
  const base = vrm('Rose'); const coat = vrm('Rose coat');
  const t = rig({
    files: { 'rose/base': base, 'rose/coat': coat },
    routes: {
      'get /api/account/links': { as_agent: [{ id: 'lnk_8', status: 'active' }] },
      'get /api/account/links/lnk_8': { link: { models: [{ model: 'rose', name: 'Rose', outfits: [{ outfit: 'base', sha256: sha(base) }, { outfit: 'coat', sha256: sha(coat) }] }] } },
      'get /api/account/links/lnk_8/roles/public': { model: 'rose', outfit: 'base', ref: 'locker:rose/base', look: null },
      'get /api/account/links/lnk_8/roles/personal': { model: 'rose', outfit: 'coat', ref: 'locker:rose/coat', look: null }
    }
  });
  t.p.portraitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portraits-'));
  const renders = [];
  t.p.renderPortraitFn = async ({ modelPath, look }) => { renders.push(path.basename(modelPath)); return Buffer.from(`png-${renders.length}`); };
  const applied = [];
  // The real appliers, with the last step (every service) recorded instead of run.
  t.p.applyPublicPicture = async function (id) { const png = await this.modelPortrait(id, await this.roleLook('public', id)); applied.push(['public', id, String(png)]); return 'ok'; };
  t.p.applyPersonalPicture = async function (id) { const png = await this.modelPortrait(id, await this.roleLook('personal', id)); applied.push(['personal', id, String(png)]); return {}; };
  await t.p.syncLinks();
  assert.deepEqual(applied.map(a => a.slice(0, 2)), [['public', 'store-linked-lnk-8-rose-base'], ['personal', 'store-linked-lnk-8-rose-coat']]);
  assert.equal(renders.length, 2);
  // A second sync with the same picks applies nothing and renders nothing.
  await t.p.syncLinks();
  assert.equal(applied.length, 2);
  assert.equal(renders.length, 2);
  // The portrait is kept: asked again, it is read, not rendered.
  assert.equal(String(await t.p.modelPortrait('store-linked-lnk-8-rose-base')), 'png-1');
  assert.equal(renders.length, 2);
});

test('linked fits (store 0.53): status per body, unsupported props left off, fitted placements, fitted clips by ETag, solves on the link', async () => {
  const { default: JSZip } = await import('jszip');
  const base = vrm('Rose');
  const vrma = glb({ extensions: { VRMC_vrm_animation: { humanoid: { humanBones: {} } } } });
  const z = new JSZip(); z.file('heart-hands.vrma', vrma);
  const pack = await z.generateAsync({ type: 'nodebuffer' });
  const t = rig({
    files: { 'rose/base': base },
    routes: {
      'get /api/account/links': { as_agent: [{ id: 'lnk_9', status: 'active' }] },
      'get /api/account/links/lnk_9': { link: { models: [{ model: 'rose', name: 'Rose', outfits: [{ outfit: 'base', sha256: sha(base) }] }] } },
      'get /api/account/links/lnk_9/roles/personal': { model: 'rose', outfit: 'base', ref: 'locker:rose/base', look: null },
      'get /api/account/links/lnk_9/fit/rose/base': { fitted_for_sha256: sha(base), body_class: 'slim', job: null,
        props: { mug: { state: 'unsupported', reason: 'it goes 18 mm into the body' }, phone: { state: 'fitted', clips: [{ clip: 'phone-call-loop', placements: { standard: { bone: 'rightHand', position: [0, 0.1, 0], rotation: [0, 0, 0] } } }] } },
        packs: { 'vrm-emote-animations-1': 'fitted' },
        clips: [{ pack: 'vrm-emote-animations-1', etag: '"e1"' }] }
    }
  });
  t.p.wearGalleryModel = async (id) => { t.p.agent.agentModel.activeVRMModel = id; };
  const clipFetches = [];
  const fileHttp = t.p.http;
  t.p.http = async (req) => {
    if (/\/clips\//.test(req.url)) { clipFetches.push(req.headers['If-None-Match'] || null); return req.headers['If-None-Match'] === '"e1"' ? { status: 304, data: Buffer.alloc(0), headers: {} } : { status: 200, data: pack, headers: { etag: '"e1"', 'content-type': 'application/zip' } }; }
    return fileHttp(req);
  };
  await t.p.syncLinks();
  const id = 'store-linked-lnk-9-rose-base';
  assert.equal(t.p.agent.agentModel.activeVRMModel, id);
  // The mug is refused on this body (its .vrm sha256 is the fitted one), with the store's reason.
  const off = await t.p.unsupportedProps(id);
  assert.equal(off.get('mug'), 'it goes 18 mm into the body');
  // The phone's placement solved on this body reaches the 3D page.
  const lp = (await PluginSettings.getCached('botsandborgs', 'liveProps')).props.find(p => p.prop === 'phone');
  assert.equal(lp.fitted, true); assert.equal(lp.fitted_for_sha256, sha(base)); assert.equal(lp.clips[0].placements.standard.bone, 'rightHand');
  // The fitted clip pack is unpacked for this body and played on it; another body plays the pack's own.
  const fitted = await t.p.clipFileFor(id, 'store/vrm-emote-animations-1/heart-hands.vrma');
  assert.match(fitted, /animations\/fitted\/linked-lnk-9-rose-base\/vrm-emote-animations-1\/heart-hands\.vrma$/);
  assert.ok(fs.existsSync(fitted));
  assert.match(await t.p.clipFileFor('store-vrm-racer-blue-bundle', 'store/vrm-emote-animations-1/heart-hands.vrma'), /animations\/store\/vrm-emote-animations-1\/heart-hands\.vrma$/);
  // Unchanged pack: not fetched again (same ETag listed).
  await t.p.syncLinks();
  assert.equal(clipFetches.length, 1);
  // A new move on this body goes to the Animation API as the link.
  t.p._linkCache = await t.p.linkState();
  assert.deepEqual(t.p.animAvatar(), { link: 'lnk_9', model: 'rose', outfit: 'base' });
});

test('linkFitProps: placements mapped by prop then clip are read too', async () => {
  const { linkFitProps } = await import('../../src/api/plugins/botsandborgs.js');
  const out = linkFitProps({ placements: { mug: { 'mug-sip-idle': { bone: 'rightHand', position: [0, 0, 0] } } } }, 'abc');
  assert.deepEqual(out, [{ prop: 'mug', fitted: true, fitted_for_sha256: 'abc', clips: [{ clip: 'mug-sip-idle', placements: { standard: { bone: 'rightHand', position: [0, 0, 0] } } }] }]);
});

test('"use the glados avatar for Jo" reaches the roles with a person as the role: it sets that person\'s avatar', async () => {
  const t = rig();
  let got = null;
  t.p.setContactLook = async (a) => { got = a; return { success: true, result: 'ok' }; };
  const r = await t.p.rolesCommand({ role: 'Jo', item: 'glados avatar' });
  assert.equal(r.success, true);
  assert.equal(got.contact, 'Jo');
  assert.equal(got.look, 'glados');
  assert.match((await t.p.rolesCommand({ role: 'Jo' })).error, /roles are public, assistant and personal/);
});
