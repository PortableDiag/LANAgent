/**
 * Tell an AvatarX sidecar which VRM this agent wears. AvatarX is an optional extra body for the agent, beside the
 * avatar designer and playground, which stay as they are. The agent pushes and AvatarX never polls (AvatarX README,
 * "Other agents"). Off unless AVATARX_URL and AVATARX_AGENT_KEY_FILE are set. A .vrm stays on this machine.
 * AvatarX makes its own certificate: AVATARX_CA_FILE names it, and it is verified, never skipped.
 */
import fs from 'fs/promises';
import path from 'path';
import https from 'node:https';
import axios from 'axios';
import { DATA_PATH } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

/** fetch's shape over axios, which can be told which certificate to trust. */
function fetcherTrusting(ca) {
  const httpsAgent = ca ? new https.Agent({ ca }) : undefined;
  return async (url, { method, body, headers }) => {
    const res = await axios({ url, method, data: body, headers, httpsAgent, timeout: 120000, maxBodyLength: Infinity, validateStatus: () => true });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.data };
  };
}

/** An authorized caller for the sidecar's agent API, or null when AvatarX is not set up here. */
async function connect({ url = process.env.AVATARX_URL, keyFile = process.env.AVATARX_AGENT_KEY_FILE, caFile = process.env.AVATARX_CA_FILE, fetchFn } = {}) {
  if (!url || !keyFile) return null;
  const send = fetchFn || fetcherTrusting(caFile ? await fs.readFile(caFile) : null);
  const key = (await fs.readFile(keyFile, 'utf8')).trim();
  const base = String(url).replace(/\/+$/, '');
  return async (method, route, body, type = 'application/json') => {
    const res = await send(`${base}${route}`, {
      method, body, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': type } : {}) }
    });
    if (!res.ok) throw new Error(`AvatarX ${method} ${route}: ${res.status}`);
    return res.json();
  };
}

/** The agent-API caller, or null when AvatarX is not set up here. */
export const avatarxCaller = (opts) => connect(opts);

/** AvatarX's name for a clip: its file stem, lower case, [a-z0-9_-] (AvatarX store::clean_name). */
export function avatarxClipName(file) {
  const stem = path.basename(String(file || '')).replace(/\.(vrma|fbx)$/i, '');
  return stem.split('').map(c => /[A-Za-z0-9_-]/.test(c) ? c.toLowerCase() : '_').join('').slice(0, 60);
}

/**
 * Give AvatarX the clips this agent owns, so each is a button there and the agent can play it. Clips are keyed by name
 * and a re-upload replaces, so this is safe to repeat. A name that is one of AvatarX's built-in gestures gets a bnb-
 * prefix, never shadowing it. clips: [{ file (absolute path), name?, replace? }]: `replace` uploads even when AvatarX holds
 * the name already (the store reissued the file: Set One's Wave, 2026-11-09). Returns the names AvatarX holds, or 'not connected'.
 */
export async function pushClipsToAvatarX(clips, opts = {}) {
  const call = await connect(opts);
  if (!call) return 'not connected';
  const state = await call('GET', '/agent/v1/state');
  const builtIn = new Set(state.gestures || []);
  const have = new Set(state.animations || []);
  const names = [];
  for (const c of clips) {
    let name = avatarxClipName(c.name || c.file);
    if (!name) continue;
    // bnb- once a built-in had the name: keep that name though AvatarX has since dropped the built-in (its wave, 0.3.4).
    if (builtIn.has(name) || have.has(`bnb-${name}`.slice(0, 60))) name = `bnb-${name}`.slice(0, 60);
    if (!have.has(name) || c.replace) {
      const up = await call('POST', `/agent/v1/animations?name=${encodeURIComponent(name)}`, await fs.readFile(c.file), 'application/octet-stream');
      name = up.animation || name;
      logger.info(`AvatarX: added clip ${name}`);
    }
    names.push(name);
  }
  return names;
}

/**
 * Give AvatarX (0.3.16+, POST /agent/v1/props) the props this agent owns: each .glb and an attach.json naming the
 * AvatarX clips it goes with. listed = store.json entries ({ file, props: [{prop, file, bone, position, rotation}] }),
 * vrmDir = where their files are. The .glb goes up only when AvatarX lacks it or holds another size; the attach when
 * its placements differ. One prop failing is logged and the rest go on. Returns the prop names AvatarX holds, or
 * 'not connected'. An AvatarX older than props answers 404 and gets nothing: 'unsupported'.
 */
export async function pushPropsToAvatarX(listed, vrmDir, opts = {}) {
  const byProp = new Map();
  for (const c of Array.isArray(listed) ? listed : []) {
    // AvatarX shows a prop whenever its clip plays, with no request to ask: on-request props (the mic) stay off it.
    for (const p of (c.props || []).filter(x => !x.onRequest)) {
      const base = avatarxClipName(p.prop || p.file);
      if (!base) continue;
      // One AvatarX prop per build (2119 #559: a placement can name its own .glb).
      const file = path.join(vrmDir, p.file);
      let name = base;
      for (const [k, v] of byProp) if (v.prop === base && v.file === file) name = k;
      if (byProp.has(base) && byProp.get(base).file !== file && name === base) name = `${base}-${path.basename(file, '.glb')}`.slice(0, 60);
      if (!byProp.has(name)) byProp.set(name, { prop: base, file, clips: {}, not: new Map(), families: p.families || [] });
      if (p.unsupported_on?.length) byProp.get(name).not.set(avatarxClipName(c.file), p.unsupported_on);
      const at = { bone: p.bone, position: p.position, rotation: p.rotation };
      for (const k of ['scale', 'scale_with', 'ref_hips', 'show', 'prop_loop', 'prop_anim']) if (p[k] != null) at[k] = p[k];
      byProp.get(name).clips[avatarxClipName(c.file)] = at;
    }
  }
  if (!byProp.size) return [];
  const call = await connect(opts);
  if (!call) return 'not connected';
  const state = await call('GET', '/agent/v1/state');
  if (!Array.isArray(state.props)) return 'unsupported';
  const held = new Map(state.props.map(p => [p.name, p]));
  const same = (a, b) => ['bone', 'position', 'rotation', 'scale_with', 'ref_hips', 'show', 'prop_loop', 'prop_anim'].every(k => JSON.stringify(a?.[k]) === JSON.stringify(b?.[k]))
    && (a?.scale ?? 1) === (b?.scale ?? 1);
  const done = [];
  for (const [name, want] of byProp) {
    try {
      const glb = await fs.readFile(want.file);
      const there = held.get(name);
      if (!there || !String(there.rev || '').startsWith(`${glb.length}-`)) {
        await call('POST', `/agent/v1/props?name=${encodeURIComponent(name)}`, glb, 'application/octet-stream');
        logger.info(`AvatarX: added prop ${name}`);
      }
      const clipsThere = there?.clips || {};
      const changed = Object.keys(want.clips).length !== Object.keys(clipsThere).length
        || Object.entries(want.clips).some(([k, v]) => !same(v, clipsThere[k]));
      // Which bodies it is not for, and the seat and build of a family of bodies (AvatarX 0.4.15).
      const not = unsupportedList(want.not);
      const families = Object.fromEntries(want.families.map(({ name: n, ...f }) => [n, f]));
      const sort = (l) => JSON.stringify((l || []).map(e => [[...e.bodies].sort(), [...(e.clips || [])].sort(), e.reason || '']).sort());
      const seats = (f) => JSON.stringify(Object.entries(f || {}).map(([n, x]) => [n, [...(x.bodies || [])].sort(), x.bone, x.position, x.rotation, x.scale ?? 1, x.file ? avatarxClipName(String(x.file).replace(/\.glb$/i, '')) : null]).sort());
      const more = sort(not) !== sort(there?.unsupported) || seats(families) !== seats(there?.families);
      const builds = new Set(want.families.map(f => f.file).filter(Boolean));
      for (const b of builds) {
        const build = await fs.readFile(path.join(path.dirname(want.file), b));
        if (String(there?.files?.[avatarxClipName(b.replace(/\.glb$/i, ''))] || '').startsWith(`${build.length}-`)) continue;
        await call('POST', `/agent/v1/props?name=${encodeURIComponent(name)}&file=${encodeURIComponent(b)}`, build, 'application/octet-stream');
      }
      if (!there || changed || more) {
        const full = { clips: want.clips, ...(not.length ? { unsupported_on: not } : {}), ...(want.families.length ? { families } : {}) };
        await call('POST', `/agent/v1/props?name=${encodeURIComponent(name)}`, JSON.stringify(full));
      }
      done.push(name);
    } catch (e) {
      logger.warn(`AvatarX: prop ${name} not given: ${e.message}`);
    }
  }
  return done;
}

/** Play a gesture or an owned clip on AvatarX now. Returns 'played', or 'not connected'. */
export async function playOnAvatarX(name, opts = {}) {
  const call = await connect(opts);
  if (!call) return 'not connected';
  await call('POST', '/agent/v1/gesture', JSON.stringify({ name }));
  logger.info(`AvatarX: played ${name}`);
  return 'played';
}

/** Who knows which clips a model must not play: async (modelId) => { reason, clips: iterable of stems } | null (the store plugin). */
let blockedFor = null;
export function setBlockedSource(fn) { blockedFor = fn; }

/** Who knows a model's store name ("racer-blue"), by which AvatarX picks a prop's seat: async (modelId) => name | null. */
let bodyNameOf = null;
export function setBodyNameSource(fn) { bodyNameOf = fn; }

/** AvatarX (0.4.13+) matches a pack's bodies by the avatar's store name: told when it has none or another. */
async function sendBodyName(call, id, modelId, state) {
  if (!bodyNameOf || !id) return;
  const name = await Promise.resolve(bodyNameOf(modelId)).catch(() => null);
  if (!name || (state?.avatars || []).find(a => a.id === id)?.store === name) return;
  await call('PATCH', '/agent/v1/state', JSON.stringify({ stores: { [id]: name } })).catch(e => logger.warn(`AvatarX: store name not set on ${id}: ${e.message}`));
}

/** A prop's `unsupported_on` as AvatarX takes it, its clips gathered by bodies and reason. */
export function unsupportedList(byClip) {
  const out = new Map();
  for (const [clip, list] of byClip) for (const e of list || []) {
    const k = JSON.stringify([e.bodies, e.reason]);
    if (!out.has(k)) out.set(k, { bodies: e.bodies, clips: [], reason: e.reason });
    out.get(k).clips.push(clip);
  }
  return [...out.values()];
}

/** The blocked entry AvatarX wants for a body: the clip names it plays them under, and the reason; null lifts it. */
export function blockedEntry(not) {
  const stems = [...(not?.clips || [])];
  if (!stems.length) return null;
  // A name's spaces are underscores in AvatarX and hyphens in the store's stems: both are named.
  const clips = [...new Set(stems.flatMap(s => [avatarxClipName(s), avatarxClipName(s).replace(/-/g, '_'), avatarxClipName(s).replace(/-(\d+)$/, '_$1')]))];
  return { clips, reason: String(not.reason || '').slice(0, 500) };
}

/**
 * Tell AvatarX (0.4.14) which clips a body must not play. Sent when there is a list, or to lift one it was given; an
 * older AvatarX refuses the field, which is logged and changes nothing else.
 */
async function sendBlocked(call, id, modelId, state) {
  if (!blockedFor || !id) return;
  const want = blockedEntry(await Promise.resolve(blockedFor(modelId)).catch(() => null));
  const held = (state?.avatars || []).find(a => a.id === id)?.blocked || null;
  if (!want && !blockedSent.has(id) && !held) return;
  if (blockedSent.get(id) === JSON.stringify(want)) return;
  try {
    await call('PATCH', '/agent/v1/state', JSON.stringify({ blocked: { [id]: want } }));
    blockedSent.set(id, JSON.stringify(want));
    logger.info(want ? `AvatarX: ${want.clips.length} clip names blocked on ${id}: ${want.reason}` : `AvatarX: no clips blocked on ${id} any more`);
  } catch (e) { logger.warn(`AvatarX: blocked clips not set on ${id}: ${e.message}`); }
}
const blockedSent = new Map();

/** The blocked list of one gallery model, for a body AvatarX already has (by name and size). Returns its id, or null. */
export async function pushBlockedToAvatarX(modelId, { vrmDir = path.join(DATA_PATH, 'vrm-models'), ...opts } = {}) {
  const call = await connect(opts);
  if (!call) return null;
  const model = JSON.parse(await fs.readFile(path.join(vrmDir, 'manifest.json'), 'utf8')).find(m => m.id === modelId);
  if (!model?.file) return null;
  const { size } = await fs.stat(path.join(vrmDir, model.file));
  const state = await call('GET', '/agent/v1/state');
  const id = (state.avatars || []).find(a => a.name === (model.name || modelId) && (a.size == null || Number(a.size) === size))?.id || null;
  await sendBlocked(call, id, modelId, state);
  return id;
}

export async function pushModelToAvatarX(modelId, {
  url = process.env.AVATARX_URL,
  keyFile = process.env.AVATARX_AGENT_KEY_FILE,
  caFile = process.env.AVATARX_CA_FILE,
  vrmDir = path.join(DATA_PATH, 'vrm-models'),
  fetchFn,
  link = null,
  look = null
} = {}) {
  const call = await connect({ url, keyFile, caFile, fetchFn });
  if (!call) return 'not connected';
  const manifest = JSON.parse(await fs.readFile(path.join(vrmDir, 'manifest.json'), 'utf8'));
  const model = manifest.find(m => m.id === modelId);
  if (!model?.file) throw new Error(`model ${modelId} is not in the gallery`);
  const name = model.name || modelId;
  // An upload always adds an entry and the agent's key can't delete one, so look by name first.
  const state = await call('GET', '/agent/v1/state');
  // Same name AND same size is the same file. A store fix keeps the name and changes the bytes (Racer Blue's hair,
  // 2026-11-08): then the new file goes up and is shown. The agent's key can't delete, so the old copy stays in
  // AvatarX's list (Settings) until the owner removes it; the log says which.
  const bytes = await fs.readFile(path.join(vrmDir, model.file));
  const same = (state.avatars || []).filter(a => a.name === name);
  let id = same.find(a => a.size == null || Number(a.size) === bytes.length)?.id;
  if (!id) {
    // A body lent through a store link (AvatarX 0.4.5): tagged, so the agent may remove it when the owner unlinks.
    const up = await call('POST', `/agent/v1/avatars?name=${encodeURIComponent(name)}${link ? `&link=${encodeURIComponent(link)}` : ''}`, bytes, 'application/octet-stream');
    id = up.avatar?.id;
    if (!id) throw new Error('AvatarX answered an upload with no id');
    if (same.length) logger.info(`AvatarX: ${name} changed (${bytes.length} bytes); older copies left to remove in AvatarX Settings: ${same.map(a => a.id).join(', ')}`);
  }
  // The owner's saved look on a lent body (AvatarX 0.4.5+: lent bodies only); sent each time, AvatarX re-wears on change.
  if (look && link) await call('PATCH', '/agent/v1/state', JSON.stringify({ looks: { [id]: look } })).catch(e => logger.warn(`AvatarX: look not set on ${name}: ${e.message}`));
  await sendBodyName(call, id, modelId, state);
  await sendBlocked(call, id, modelId, state); // before it shows
  if (state.active === id) return 'unchanged';
  await call('PATCH', '/agent/v1/state', JSON.stringify({ active: id }));
  logger.info(`AvatarX: now showing ${name} (${id})`);
  return 'updated';
}

/**
 * Take every body lent through one store link off AvatarX (0.4.5: the agent key may DELETE only a lent body). Returns
 * the ids removed, or 'not connected'.
 */
export async function removeLentAvatars(linkId, opts = {}) {
  const call = await connect(opts);
  if (!call) return 'not connected';
  const state = await call('GET', '/agent/v1/state');
  const lent = (state.avatars || []).filter(a => a.link && a.link === linkId);
  const done = [];
  for (const a of lent) {
    try { await call('DELETE', `/agent/v1/avatars/${encodeURIComponent(a.id)}`); done.push(a.id); }
    catch (e) { logger.warn(`AvatarX: lent body ${a.id} not removed: ${e.message}`); }
  }
  return done;
}
