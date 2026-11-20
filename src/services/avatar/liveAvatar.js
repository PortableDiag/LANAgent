/**
 * The agent's own live avatar: the same body, settings and agent controls AvatarX has, served by the agent itself
 * (owner, 2026-11-16: "make sure the android app and avatar designer can do everything avatarx can do so it has
 * parity and doesnt matter which one the user picks"). AvatarX stays fully supported beside it; nothing here needs it.
 *
 * The page (public/avatar-live.html, built from web/avatar-live/src) is AvatarX's own page, so it moves exactly as
 * AvatarX does. This module is what that page talks to:
 *   - the bodies are the gallery (data/vrm-models/manifest.json), the active one is the designer's (Agent.activeVRMModel)
 *   - the clips are the designer's library (animations.json + store.json) plus the owner's uploads, named the AvatarX way
 *   - the props are the store's clip props in AvatarX's attach form, plus uploads
 *   - the backgrounds are the four colours, the store's scenes and uploads
 *   - settings (zoom, background, mood, look-at, spoken replies, standing loop) live in one JSON file; the voice is always
 *     the agent's own set voice, never one per body (owner, 2026-11-16)
 * Live changes (state, expression, gesture) go out on one bus: every open live page, the designer and the playground.
 */
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { DATA_PATH } from '../../utils/paths.js';
import { avatarxClipName } from './avatarx.js';

export const BACKGROUNDS = ['nebula', 'dusk', 'studio', 'black'];
export const MOODS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
/** Head moves the page makes in code (AvatarX motion.js GESTURES); every other move is a clip. */
export const GESTURES = ['nod', 'shake_head', 'look_around'];
/** OpenAI's realtime and speech voices, with how each sounds, so a voice can be matched to the body. */
export const VOICES = [['marin', 'woman'], ['coral', 'woman'], ['sage', 'woman'], ['shimmer', 'woman'],
  ['cedar', 'man'], ['ash', 'man'], ['ballad', 'man'], ['echo', 'man'], ['verse', 'man'], ['alloy', 'neutral']];

const DEFAULTS = { background: 'nebula', zoom: 1, look_at_you: true, mood: 'neutral', speak_replies: true, idle: '', voices: {} };
const CHAT_KEEP = 200;
const NAME_OK = /^[a-z0-9_-]{1,60}$/;

export const bus = new EventEmitter();
bus.setMaxListeners(100);
/** Tell every open avatar page: { type: 'state' } | { type: 'expression', name, seconds } | { type: 'gesture', name }. */
export function broadcast(event) { bus.emit('event', event); }

export function dirs(root = DATA_PATH) {
  const live = path.join(root, 'avatar-live');
  return {
    vrm: path.join(root, 'vrm-models'),
    live,
    animations: path.join(live, 'animations'),
    props: path.join(live, 'props'),
    backgrounds: path.join(live, 'backgrounds'),
    stateFile: path.join(live, 'state.json'),
    chatFile: path.join(live, 'chat.json')
  };
}

/** A file name made safe the AvatarX way: lower case [a-z0-9_-], at most 60. Empty when nothing is left. */
export function cleanName(name) {
  const stem = path.basename(String(name || '')).replace(/\.[a-z0-9]+$/i, '');
  const n = stem.split('').map(c => (/[A-Za-z0-9_-]/.test(c) ? c.toLowerCase() : '_')).join('').replace(/^_+|_+$/g, '').slice(0, 60);
  return NAME_OK.test(n) ? n : '';
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

/** The gallery: [{ id, name, file, size }]. */
export async function avatars(d = dirs()) {
  const list = await readJson(path.join(d.vrm, 'manifest.json'), []);
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m?.id || !m.file) continue;
    const file = path.join(d.vrm, path.basename(m.file));
    const st = await fs.stat(file).catch(() => null);
    if (st) out.push({ id: String(m.id), name: String(m.name || m.id), file, size: st.size });
  }
  return out;
}

/**
 * Every clip the page can play, by AvatarX name: { name → absolute file }. The designer's library first, then the
 * store's, then the owner's uploads (an upload of the same name wins: it was made on purpose).
 */
export async function clips(d = dirs()) {
  const map = new Map();
  const animDir = path.join(d.vrm, 'animations');
  for (const list of ['animations.json', 'store.json']) {
    for (const c of await readJson(path.join(animDir, list), [])) {
      // Broad-shouldered versions are not for these bodies; a loop's -in/-out/-once companions are not moves of their own.
      if (!c?.file || /(^|\/)broad\//i.test(c.file) || c.role) continue;
      const file = path.join(animDir, c.file);
      if (!file.startsWith(animDir + path.sep)) continue;
      let name = avatarxClipName(c.file);
      // Named after a built-in head move: it keeps the move's name free (AvatarX's bnb- rule).
      if (GESTURES.includes(name)) name = `bnb-${name}`;
      if (name && !map.has(name) && fsSync.existsSync(file)) map.set(name, file);
    }
  }
  for (const f of await fs.readdir(d.animations).catch(() => [])) {
    if (!/\.(vrma|fbx)$/i.test(f)) continue;
    const name = cleanName(f);
    if (name) map.set(name, path.join(d.animations, f));
  }
  return map;
}

const stamp = (st) => `${st.size}-${Math.round(st.mtimeMs)}`;

/**
 * The props, in the form AvatarX's page reads ({ name, rev, clips, fits }), each with the .glb it loads.
 * Store props come from store.json (the clip each one goes with); on-request props (the mic) stay off, as on AvatarX.
 */
export async function props(d = dirs()) {
  const byProp = new Map();
  for (const c of await readJson(path.join(d.vrm, 'animations', 'store.json'), [])) {
    for (const p of (c?.props || []).filter(x => !x.onRequest)) {
      const base = avatarxClipName(p.prop || p.file);
      const glb = path.join(d.vrm, String(p.file || ''));
      if (!base || !glb.startsWith(path.join(d.vrm, 'props') + path.sep)) continue;
      // One entry per build: a prop whose placements name different .glb files (2119 #559) is several props on the page.
      const name = buildName(byProp, base, glb);
      if (!byProp.has(name)) byProp.set(name, { name, prop: base, glb, clips: {}, fits: null });
      const at = { bone: p.bone, position: p.position, rotation: p.rotation };
      for (const k of ['scale', 'scale_with', 'ref_hips', 'show', 'prop_loop', 'prop_anim']) if (p[k] != null) at[k] = p[k];
      byProp.get(name).clips[avatarxClipName(c.file)] = at;
    }
  }
  for (const f of await fs.readdir(d.props).catch(() => [])) {
    if (!f.endsWith('.glb')) continue;
    const name = cleanName(f);
    const attach = await readJson(path.join(d.props, `${name}.json`), null);
    if (!name || !attach?.clips) continue;
    byProp.set(name, { name, glb: path.join(d.props, f), clips: attach.clips, fits: attach.fits || null, defaults: attach });
  }
  const out = [];
  for (const p of byProp.values()) {
    const st = await fs.stat(p.glb).catch(() => null);
    if (!st) continue;
    // Defaults on the prop fill each clip's own placement (AvatarX parse_attach).
    const base = p.defaults ? Object.fromEntries(['bone', 'position', 'rotation', 'scale', 'scale_with', 'ref_hips'].filter(k => p.defaults[k] != null).map(k => [k, p.defaults[k]])) : {};
    const clipsOut = Object.fromEntries(Object.entries(p.clips).map(([k, v]) => [k, { ...base, ...(v?.standard || v || {}) }]));
    out.push({ name: p.name, prop: p.prop || p.name, rev: `${stamp(st)}-${Object.keys(clipsOut).length}`, clips: clipsOut, fits: p.fits, glb: p.glb });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Placements the store solved on THIS body (store 0.28, GET /api/live/<slug>/props: fitted, fitted_for_sha256,
 * fit_current) replace the pack's for the clips they cover, but only when the body showing is the one they were
 * solved on (`sha256` of its .vrm). Everything else keeps the pack placements.
 */
export function applyFits(propList, liveProps, sha256) {
  if (!sha256 || !Array.isArray(liveProps) || !liveProps.length) return propList;
  return propList.map(p => {
    const lp = liveProps.find(x => avatarxClipName(x.prop) === (p.prop || p.name) && x.fitted && x.fitted_for_sha256 === sha256);
    if (!lp) return p;
    const clipsOut = { ...p.clips };
    let n = 0;
    for (const c of Array.isArray(lp.clips) ? lp.clips : []) {
      const at = c?.placements?.standard || c?.placements?.fitted || c?.placement;
      const key = avatarxClipName(c?.clip || '');
      if (!at?.bone || !key || !(key in clipsOut)) continue;
      clipsOut[key] = { ...clipsOut[key], ...at };
      n++;
    }
    return n ? { ...p, clips: clipsOut, rev: `${p.rev}-fit${n}` } : p;
  }).flatMap(splitByPlacementFile);
}

/**
 * The entry name for a prop build: the prop's own name for its first .glb, `<prop>-<file stem>` for any other
 * (the Santa hat ships one build per hair family, 2119 #559).
 */
export function buildName(byName, base, glb) {
  for (const [k, v] of byName) if ((v.prop || v.name) === base && v.glb === glb) return k;
  const first = byName.get(base);
  return !first || first.glb === glb ? base : `${base}-${path.basename(glb, '.glb')}`.slice(0, 60);
}

/** A prop whose clips' placements carry a `file` (a fitted build) split into one entry per .glb, beside its pack file. */
export function splitByPlacementFile(p) {
  const groups = new Map();
  for (const [clip, at] of Object.entries(p.clips || {})) {
    const own = typeof at?.file === 'string' && /^[\w.-]+\.glb$/i.test(path.basename(at.file)) ? path.join(path.dirname(p.glb), path.basename(at.file)) : p.glb;
    const { file, ...rest } = at || {};
    if (!groups.has(own)) groups.set(own, {});
    groups.get(own)[clip] = rest;
  }
  if (groups.size <= 1 && (!groups.size || groups.has(p.glb))) return [groups.size ? { ...p, clips: groups.get(p.glb) } : p];
  return [...groups].map(([glb, clips]) => ({ ...p, prop: p.prop || p.name, glb, clips,
    name: glb === p.glb ? p.name : `${p.prop || p.name}-${path.basename(glb, '.glb')}`.slice(0, 60), rev: `${p.rev}-${path.basename(glb, '.glb')}` }));
}

const shaCache = new Map();
/** The sha256 of a file, cached by path, size and time. */
export async function fileSha256(file) {
  const st = await fs.stat(file).catch(() => null);
  if (!st) return null;
  const k = `${file}:${st.size}:${st.mtimeMs}`;
  if (shaCache.has(k)) return shaCache.get(k);
  const { createHash } = await import('crypto');
  const h = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  shaCache.set(k, h);
  return h;
}

/** Uploaded scenes and the store's: { name → file }. */
export async function customBackgrounds(d = dirs(), storeScenes = []) {
  const map = new Map();
  for (const s of storeScenes) if (s?.name && s.file) map.set(s.name, s.file);
  for (const f of await fs.readdir(d.backgrounds).catch(() => [])) {
    if (!/\.(jpe?g|png)$/i.test(f)) continue;
    const name = cleanName(f);
    if (name && !BACKGROUNDS.includes(name)) map.set(name, path.join(d.backgrounds, f));
  }
  return map;
}

export async function readSettings(d = dirs()) {
  const s = await readJson(d.stateFile, {});
  return { ...DEFAULTS, ...s, voices: { ...(s.voices || {}) } };
}

/**
 * A change to the settings, checked the AvatarX way. `active` is the designer's choice (setActive), the rest is
 * this file's. Returns the new settings; throws a 400 error naming the bad field.
 */
export async function applyPatch(patch, { d = dirs(), known = {}, setActive } = {}) {
  const s = await readSettings(d);
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (patch.active !== undefined) {
    if (!(known.avatars || []).some(a => a.id === patch.active)) throw bad('no such avatar');
    await setActive?.(patch.active);
  }
  if (patch.background !== undefined) {
    if (!BACKGROUNDS.includes(patch.background) && !(known.backgrounds || []).includes(patch.background)) throw bad('no such background');
    s.background = patch.background;
  }
  if (patch.zoom !== undefined) {
    const z = Number(patch.zoom);
    if (!(z >= 0.5 && z <= 3)) throw bad('zoom is 0.5 to 3');
    s.zoom = z;
  }
  if (patch.look_at_you !== undefined) s.look_at_you = patch.look_at_you === true;
  if (patch.speak_replies !== undefined) s.speak_replies = patch.speak_replies === true;
  if (patch.mood !== undefined) {
    if (!MOODS.includes(patch.mood)) throw bad(`mood is one of ${MOODS.join(', ')}`);
    s.mood = patch.mood;
  }
  if (patch.idle !== undefined) {
    if (patch.idle !== '' && !(known.animations || []).includes(patch.idle)) throw bad('no such clip');
    s.idle = patch.idle;
  }
  // The voice is the agent's own and is not set here (see publicState).
  if (patch.voice !== undefined && patch.voice !== 'agent' && patch.voice !== '') throw bad("the voice is the agent's own; change it in the agent's voice settings");
  await writeJson(d.stateFile, s);
  return s;
}

/** What the page reads (AvatarX public_state), from the live files. */
export function publicState({ settings, active, avatarList, clipNames, propList, backgroundNames, agentVoice = null }) {
  return {
    active: active || null,
    background: settings.background,
    zoom: settings.zoom,
    look_at_you: settings.look_at_you,
    mood: settings.mood,
    speak_replies: settings.speak_replies,
    idle: clipNames.includes(settings.idle) ? settings.idle : '',
    // One voice: the agent's own (the owner, 2026-11-16: an agent sticks to its set voice; only realtime changes it,
    // and only on a fallback). AvatarX's per-avatar voice choice is deliberately not offered here.
    voice: 'agent',
    voices: [{ name: 'agent', sounds: agentVoice?.speech ? `the agent's own: ${agentVoice.speech}${agentVoice.realtime ? `, talk ${agentVoice.realtime}` : ''}` : "the agent's own" }],
    avatars: avatarList.map(({ id, name, size }) => ({ id, name, size })),
    backgrounds: [...BACKGROUNDS, ...backgroundNames],
    custom_backgrounds: backgroundNames,
    moods: MOODS,
    gestures: GESTURES,
    animations: clipNames,
    props: propList.map(({ name, rev, clips: c, fits }) => ({ name, rev, clips: c, ...(fits ? { fits } : {}) }))
  };
}

/**
 * The move a name plays (AvatarX store::resolve_move): the clip itself, else one named for it ("wave" → bnb-wave or
 * "...-wave"), else a head move; the store's facing-away version when there is one (the owner wants that one).
 */
export function resolveMove(name, clipNames) {
  const n = cleanName(name) || String(name || '');
  const front = n.endsWith('-front') ? n.slice(0, -6) : null;
  if (front && clipNames.includes(front)) return front;
  const plain = clipNames.includes(n) ? n
    : clipNames.includes(`bnb-${n}`) ? `bnb-${n}`
      : clipNames.find(c => c.endsWith(`-${n}`)) || clipNames.find(c => c.endsWith(`-${n.replace(/_/g, '-')}`))
        || (GESTURES.includes(n) ? n : null);
  if (!plain) return null;
  return clipNames.includes(`${plain}-facing-away`) ? `${plain}-facing-away` : plain;
}

// --- the page's conversation ----------------------------------------------------------------------------------------
export async function chatLines(d = dirs()) { return readJson(d.chatFile, []); }
export async function addChatLines(lines, d = dirs()) {
  const all = [...(await chatLines(d)), ...lines.map(l => ({ role: l.role, text: String(l.text || '').slice(0, 8000), at: Date.now() }))];
  await writeJson(d.chatFile, all.slice(-CHAT_KEEP));
}
export async function newChat(d = dirs()) { await writeJson(d.chatFile, []); }

// --- uploads --------------------------------------------------------------------------------------------------------
const GLB_MAGIC = 0x46546c67; // "glTF"
export function isGlb(buf) { return Buffer.isBuffer(buf) && buf.length > 20 && buf.readUInt32LE(0) === GLB_MAGIC; }
export function isVrma(buf) { return isGlb(buf); }
export function isFbx(buf) { return Buffer.isBuffer(buf) && (buf.slice(0, 18).toString('latin1') === 'Kaydara FBX Binary' || /^; FBX/.test(buf.slice(0, 8).toString('latin1'))); }
export function imageKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

/** A .vrm into the gallery: data/vrm-models/<id>.vrm and a manifest line. `replace` swaps an existing body's file. */
export async function addAvatar(buf, name, { d = dirs(), replace = null } = {}) {
  if (!isGlb(buf)) throw Object.assign(new Error('that is not a .vrm (glTF binary)'), { status: 400 });
  const manifestFile = path.join(d.vrm, 'manifest.json');
  const list = await readJson(manifestFile, []);
  const label = String(name || 'avatar').replace(/\.vrm$/i, '').slice(0, 80) || 'avatar';
  if (replace) {
    const m = list.find(x => x.id === replace);
    if (!m) throw Object.assign(new Error('no such avatar'), { status: 404 });
    await fs.writeFile(path.join(d.vrm, path.basename(m.file)), buf);
    m.sizeMB = +(buf.length / 1048576).toFixed(1);
    await writeJson(manifestFile, list);
    return { id: m.id, name: m.name, size: buf.length };
  }
  let id = `upload-${cleanName(label) || 'avatar'}`;
  for (let i = 2; list.some(x => x.id === id); i++) id = `upload-${cleanName(label) || 'avatar'}-${i}`;
  await fs.writeFile(path.join(d.vrm, `${id}.vrm`), buf);
  list.push({ id, name: label, file: `${id}.vrm`, sizeMB: +(buf.length / 1048576).toFixed(1), description: 'Added on the live avatar page', source: 'upload' });
  await writeJson(manifestFile, list);
  return { id, name: label, size: buf.length };
}

/** Removes an uploaded body. Bodies that came with the agent or from the store stay: they are the designer's. */
export async function removeAvatar(id, { d = dirs() } = {}) {
  const manifestFile = path.join(d.vrm, 'manifest.json');
  const list = await readJson(manifestFile, []);
  const m = list.find(x => x.id === id);
  if (!m) return 'missing';
  if (m.source !== 'upload') return 'kept';
  await fs.rm(path.join(d.vrm, path.basename(m.file)), { force: true });
  await writeJson(manifestFile, list.filter(x => x.id !== id));
  return 'removed';
}

export async function addClip(buf, name, { d = dirs() } = {}) {
  const ext = isFbx(buf) ? 'fbx' : isVrma(buf) ? 'vrma' : null;
  if (!ext) throw Object.assign(new Error('a motion is a .vrma or an .fbx'), { status: 400 });
  const n = cleanName(name);
  if (!n) throw Object.assign(new Error('that name has no letters or digits'), { status: 400 });
  await fs.mkdir(d.animations, { recursive: true });
  for (const other of ['vrma', 'fbx']) await fs.rm(path.join(d.animations, `${n}.${other}`), { force: true });
  await fs.writeFile(path.join(d.animations, `${n}.${ext}`), buf);
  return n;
}

/** Only an uploaded clip can go; the designer's and the store's are part of what the agent owns. */
export async function removeClip(name, { d = dirs() } = {}) {
  const n = cleanName(name);
  let gone = false;
  for (const ext of ['vrma', 'fbx']) {
    const f = path.join(d.animations, `${n}.${ext}`);
    if (fsSync.existsSync(f)) { await fs.rm(f); gone = true; }
  }
  return gone;
}

export async function addBackground(buf, name, { d = dirs() } = {}) {
  const kind = imageKind(buf);
  if (!kind) throw Object.assign(new Error('a background is a JPEG or a PNG'), { status: 400 });
  const n = cleanName(name);
  if (!n || BACKGROUNDS.includes(n)) throw Object.assign(new Error('pick another name'), { status: 400 });
  await fs.mkdir(d.backgrounds, { recursive: true });
  for (const ext of ['jpg', 'jpeg', 'png']) await fs.rm(path.join(d.backgrounds, `${n}.${ext}`), { force: true });
  await fs.writeFile(path.join(d.backgrounds, `${n}.${kind}`), buf);
  return n;
}

export async function removeBackground(name, { d = dirs() } = {}) {
  const n = cleanName(name);
  let gone = false;
  for (const ext of ['jpg', 'jpeg', 'png']) {
    const f = path.join(d.backgrounds, `${n}.${ext}`);
    if (fsSync.existsSync(f)) { await fs.rm(f); gone = true; }
  }
  if (gone) {
    const s = await readSettings(d);
    if (s.background === n) { s.background = 'nebula'; await writeJson(d.stateFile, s); }
  }
  return gone;
}

/** A prop is two parts under one name, in either order: its .glb, and its attach.json. */
export async function addPropPart(buf, name, { d = dirs() } = {}) {
  const n = cleanName(name);
  if (!n) throw Object.assign(new Error('that name has no letters or digits'), { status: 400 });
  await fs.mkdir(d.props, { recursive: true });
  if (isGlb(buf)) { await fs.writeFile(path.join(d.props, `${n}.glb`), buf); return { name: n, part: 'model' }; }
  let attach;
  try { attach = JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('a prop is a .glb or its attach.json'), { status: 400 }); }
  if (!attach || typeof attach.clips !== 'object' || Array.isArray(attach.clips)) throw Object.assign(new Error('attach.json needs "clips": { "<clip>": { … } }'), { status: 400 });
  await fs.writeFile(path.join(d.props, `${n}.json`), JSON.stringify(attach));
  return { name: n, part: 'attach' };
}

export async function removeProp(name, { d = dirs() } = {}) {
  const n = cleanName(name);
  let gone = false;
  for (const ext of ['glb', 'json']) {
    const f = path.join(d.props, `${n}.${ext}`);
    if (fsSync.existsSync(f)) { await fs.rm(f); gone = true; }
  }
  return gone;
}

/**
 * The AvatarX agent API, in this process: what autoEmote and the store plugin call to move the body, the same calls
 * they make to AvatarX. `live` is the web interface's avatar-live service (getState, patch, expression, gesture).
 */
export function liveCaller(live) {
  return async (method, route, body) => {
    const json = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
    if (method === 'GET' && route === '/agent/v1/state') return live.getState();
    if (method === 'PATCH' && route === '/agent/v1/state') return live.patch(json);
    if (method === 'POST' && route === '/agent/v1/gesture') return live.gesture(json.name);
    if (method === 'POST' && route === '/agent/v1/expression') return live.expression(json.name, json.seconds);
    throw new Error(`the live avatar has no ${method} ${route}`);
  };
}
