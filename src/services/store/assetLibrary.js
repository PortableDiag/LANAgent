/**
 * What a bought store download holds, and where it goes. A download is one file or a zip of any layout;
 * each file is classified by its name, then kept under data/store/<variant>/. A VRM model also goes into the
 * agent's model gallery (data/vrm-models + manifest.json), where the avatar designer and every animation can use it.
 *
 * Bought models are licensed for this agent, not for redistribution: nothing here shares them, and they stay in
 * the data directory, which is never in git.
 */
import fs from 'fs/promises';
import { readFileSync, statSync } from 'fs';
import path from 'path';
import { DATA_PATH } from '../../utils/paths.js';

/** "Send me a happy sticker", "wear the bear 3D model": a request for something owned, with no store name in it. */
export function asksToUseStoreItem(text, modelNames = storeModelNames()) {
  const t = String(text || '');
  if (/\b(send|text|give)\b.{0,60}\b(stickers?|emotes?)\b/i.test(t) || /\b(wear|switch to|become|use|install)\b.{0,40}\b(vrm|3d (?:model|avatar))\b/i.test(t)) return true;
  // "Switch back to Racer Blue" went to the lights as a colour (2026-11-14): a bought model, named, after a word for
  // putting it on, is the store's.
  const wearing = '(?:wear|put on|become|turn (?:back )?into|go back to|(?:switch|change)(?: back)? (?:in)?to)';
  return modelNames.some(n => n.length >= 3 && new RegExp(`\\b${wearing}\\s+(?:(?:the|your|my|own)\\s+){0,2}${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t));
}

/**
 * A question ABOUT the store items, not an ask to use one. "The owner is asking specifically about animation 3D model
 * props they bought from Bots & Borgs. Can I use those props, and what can I do with them?" (AvatarX sidecar,
 * 2026-11-15) matched botsandborgs.use at 0.65 and played Swim Backstroke on AvatarX. A polite ask ("can you do the
 * pole dance?", "could you send me a video of you waving?") and an order ("do the pole dance") still act.
 */
export function asksAboutStoreItem(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\b(send|show|give|text|play)\s+(me|him|her|them|us)\b/i.test(t)) return false;
  const lead = String.raw`^(?:(?:hey|hi|hello|ok|okay|so|um|yo)\b[,!. ]*)?(?:\w+,\s*)?`;
  const question = new RegExp(lead + String.raw`(?:what|which|who|where|when|how|why|is|are|was|were|does|did|have|has|any|(?:can|could|may|should|do) (?:i|we)|do you (?:have|own|know)|are you able)\b`, 'i');
  const reported = /\b(?:is|was|are|were|keeps?|just)\s+(?:asking|wondering|curious)\b|\b(?:asks?|asked)\s+(?:\w+\s+){0,3}(?:about|whether|if)\b|\bplease answer\b/i;
  return question.test(t) || reported.test(t);
}

let modelNamesCache = { mtimeMs: -1, names: [] };
/** The names of the store models in the gallery ("Racer Blue", "Core"), re-read only when its manifest changes. */
export function storeModelNames(vrmDir = path.join(DATA_PATH, 'vrm-models')) {
  try {
    const file = path.join(vrmDir, 'manifest.json');
    const { mtimeMs } = statSync(file);
    if (mtimeMs !== modelNamesCache.mtimeMs) {
      const list = JSON.parse(readFileSync(file, 'utf8'));
      modelNamesCache = { mtimeMs, names: (Array.isArray(list) ? list : []).filter(m => m?.source === 'botsandborgs' && m.name).map(m => String(m.name).trim()) };
    }
    return modelNamesCache.names;
  } catch { return []; }
}

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // a guard against a bad zip, not a size limit on products
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.vrm': 'model/gltf-binary', '.vrma': 'model/gltf-binary', '.glb': 'model/gltf-binary', '.webm': 'video/webm', '.mp4': 'video/mp4', '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.pdf': 'application/pdf' };

/** The name a file may have on disk: its last path part, nothing that can climb out of the folder. */
export function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[^\p{L}\p{N} ._()-]+/gu, '_').replace(/^\.+/, '').trim();
  return base.slice(0, 120) || 'file';
}

/**
 * A live pass ("vrm-aa-core-live30"): the store hosts the model and always serves its newest version to the pass's key.
 * Returns { slug, days } (slug = the product, whose VRM variant has the same id) or null.
 */
export function livePass(variant) {
  const m = /^(vrm-[a-z0-9-]+?)-live(\d+)$/.exec(String(variant || ''));
  return m ? { slug: m[1], days: Number(m[2]) } : null;
}

/** What a variant is, from the store's own naming: a slug suffix, then the product's collection. */
export function variantKind(variant, collection = '') {
  const id = String(variant || '');
  if (/-bundle$/.test(id)) return 'bundle';
  // Add-ons on every 3D page since store 0.17 (2026-11-14, Trellis 2119 #449). Before the vrm- rule, or they read as models.
  if (/-kit$/.test(id)) return 'kit';
  if (/-voice$/.test(id)) return 'voice';
  if (/-motion$/.test(id)) return 'motion';
  if (/^vrm-.+-2d$/.test(id)) return 'portrait';
  if (collection === 'sounds' || /^call-sounds(?:-|$)/.test(id)) return 'sound';
  // Store 0.20: empty scenes to stand the avatar in (AvatarX pages, avatar videos), desktop + phone.
  if (collection === 'backgrounds' || /^bg-/.test(id)) return 'background';
  // 3D sets and 360s to film in (bnb-set/1, 3910 #5837).
  if (collection === 'sets' || /^set-/.test(id)) return 'set';
  // Props (VRM Props Pack 1, 2119 #494): .glb objects for clips that mime one. Before the vrm- rule, or a props pack
  // would install as a model.
  if (collection === 'props' || /^vrm-props?(?:-|$)/.test(id) || /-props?(?:-pack)?(?:-\d+)?$/.test(id)) return 'prop';
  if (/-stickers$/.test(id)) return 'sticker';
  if (/-portraits$/.test(id)) return 'portrait';
  // Before the vrm- rule: the store's clip packs are named vrm-dance-pack-1, vrm-emote-animations-1 (2026-11-08).
  if (collection === 'animations' || /-(?:animations?|dance-pack|dances?|emotes?|motions?)(?:-\d+)?$/.test(id)) return 'animation';
  if (collection === '3d-avatars' || /^vrm-/.test(id)) return 'vrm';
  if (collection === 'emoji' || /emoji/.test(id)) return 'emoji';
  if (collection === 'wallpapers' || /wallpaper|-phone-/.test(id)) return 'wallpaper';
  if (/-icons(?:-|$)/.test(id)) return 'icon';
  return 'portrait';
}

/** What one file in a download is. The folder or file name wins; otherwise the variant's kind decides. */
export function fileKind(filename, kind = 'portrait') {
  const n = String(filename || '').toLowerCase().replace(/\\/g, '/');
  const ext = path.extname(n);
  if (ext === '.vrm') return 'vrm';
  if (ext === '.vrma') return 'animation';
  // A set: its spec (set.json, or day.set.json and evening.set.json over one mesh) and the mesh or 360 picture it names.
  if (kind === 'set') return /(^|\/)(?:[\w-]+\.)?set\.json$/.test(n) ? 'set-spec' : /\.(txt|md|pdf)$/.test(n) ? 'document' : /preview|thumbnail|contact.?sheet/.test(n) ? 'preview' : /\.(glb|jpe?g|png|webp)$/.test(n) ? 'set-media' : null;
  // A prop's model; only a props pack holds them (a stray .glb elsewhere is not a prop).
  if (ext === '.glb') return kind === 'prop' ? 'prop' : null;
  if (/(^|\/)attach\.json$/.test(n)) return kind === 'prop' ? 'prop-manifest' : null;
  if (/\.(txt|md|pdf)$/.test(n) || /(^|\/)(readme|licen[cs]e|credits)/.test(n)) return 'document';
  // A voice pack: voice.json names the voice, and its reference lines are samples of it. Call sounds are sounds.
  // clips.json (store 0.22): every clip's tags, facing, energy and fit, in an animation pack.
  if (ext === '.json') return kind === 'voice' && /(^|\/)voice\.json$/.test(n) ? 'voice' : /(^|\/)clips\.json$/.test(n) ? 'clip-manifest' : null;
  if (/\.(flac|mp3|wav|ogg|opus|m4a)$/.test(n)) return kind === 'voice' ? 'voice-sample' : 'sound';
  if (!/\.(png|jpe?g|webp|gif|webm|mp4)$/.test(n)) return null;
  if (/preview|thumbnail|contact.?sheet/.test(n)) return 'preview';
  // A motion pack: Telegram video stickers (VP9 WebM with alpha), and looping reaction clips (WebM with alpha + MP4).
  if (kind === 'motion') return /telegram|sticker/.test(n) ? 'video-sticker' : /\.(webm|mp4)$/.test(n) ? 'clip' : 'preview';
  // An animation pack's pictures and videos only show its clips.
  if (kind === 'animation') return 'preview';
  // A profile kit: the avatar in every size, and banners (X 1500x500, YouTube 2560x1440, 4:1 …).
  if (kind === 'kit') return /banner|header|cover|\b\d{3,4}x\d{3,4}\b|\b4[x:-]1\b|youtube|twitch|discord/.test(n.replace(/(^|\/)(?:avatars?|profile)\//, '$1')) && !/(^|\/)avatars?\//.test(n) ? 'banner' : 'portrait';
  // Only a model or a bundle mixes kinds. Elsewhere a pack's name says nothing ("Agent Mode Wallpapers" is fine, a
  // portrait pack called "Sticker Bots" would not be).
  if (kind !== 'vrm' && kind !== 'bundle') return kind;
  if (/sticker/.test(n) || STICKER_NAMED.test(n)) return 'sticker';
  if (/portrait/.test(n)) return 'portrait';
  return kind === 'vrm' ? 'preview' : 'portrait';
}

/**
 * Since store v0.16.7 (2026-11-09, Trellis 3910 #109) every character's stickers are named by one word, the same 12
 * in every pack and the same words as the Bot Emoji pack: "<Name> <word>.png" ("Racer Blue lol.png").
 */
export const STICKER_WORDS = ['lol', 'love', 'wink', 'cool', 'shock', 'angry', 'nervous', 'confused', 'think', 'cry', 'sleep', 'sad'];
const STICKER_NAMED = new RegExp(`\\s(?:${STICKER_WORDS.join('|')})\\.(?:png|webp|gif|jpe?g)$`, 'i');

/** Older downloads number them instead; the numbers meant these (BotsAndBorgsAgent, Trellis 3910 #81). */
const STICKER_MOODS = ['happy, sparkle', 'love, heart', 'flirty, wink', 'cheerful, music', 'surprised', 'angry', 'sad, tears',
  'confused', 'questioning', 'awkward, sweat', 'sleepy, zzz', 'worried, nervous'];

/** The feeling a sticker or emoji shows, from its name; no model is asked. */
export function moodOf(name, kind) {
  const base = path.parse(String(name || '')).name;
  if (kind === 'sticker' || kind === 'video-sticker') {
    // Store 0.20.1 names video stickers "<Name> <emote> sticker.webm"; older ones were "<Name> <emote>.webm".
    const word = /\s([a-z]+)$/i.exec(kind === 'video-sticker' ? base.replace(/\s+sticker$/i, '') : base)?.[1]?.toLowerCase();
    if (word && STICKER_WORDS.includes(word)) return word;
    return STICKER_MOODS[Number(/sticker\s*(\d+)/i.exec(base)?.[1]) - 1] || null;
  }
  if (kind === 'emoji') return base.replace(/[-_]+/g, ' ').trim().toLowerCase() || null;
  return null;
}

/** Every usable file in a download: [{ name, kind, mime, buffer }]. A zip of any layout, or one plain file. */
export async function unpack(buffer, { type = '', kind = 'portrait', filename = '' } = {}) {
  const isZip = /zip/i.test(type) || buffer.subarray(0, 2).toString('latin1') === 'PK';
  if (!isZip) {
    const ext = path.extname(filename) || (/png/i.test(type) ? '.png' : /jpe?g/i.test(type) ? '.jpg' : /webp/i.test(type) ? '.webp' : buffer.subarray(0, 4).toString('latin1') === 'glTF' ? (kind === 'prop' ? '.glb' : '.vrm') : '');
    const name = safeName(filename || `file${ext}`);
    const k = fileKind(name.endsWith(ext) ? name : `${name}${ext}`, kind);
    return k ? [{ name: name.endsWith(ext) ? name : `${name}${ext}`, kind: k, mime: MIME[ext] || 'application/octet-stream', buffer }] : [];
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  let entries = Object.values(zip.files).filter(f => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name));
  if (entries.length > MAX_FILES) throw new Error(`The download holds ${entries.length} files, over the ${MAX_FILES} limit.`);
  // Emoji come at 512 and 128 px under the same names: the large one is the one to use.
  if (entries.some(f => /(^|\/)512px\//.test(f.name))) entries = entries.filter(f => !/(^|\/)128px\//.test(f.name));
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const f of entries) {
    const k = fileKind(f.name, kind);
    if (!k) continue;
    const bytes = await f.async('nodebuffer');
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('The download unpacks to more than 2 GB.');
    // A wallpaper pack holds the same scene under desktop/ and phone/, so the folder goes in the name. Background packs
    // (store 0.20) name the folder "phone 1080x1920/" and the size in the file: "Art Studio 1080x1920.jpg".
    const dims = /(\d{3,4})x(\d{3,4})(?=\.[a-z]+$)/i.exec(path.basename(f.name));
    const byFolder = /(^|\/)phone[^/]*\//i.test(f.name) ? 'phone' : /(^|\/)desktop[^/]*\//i.test(f.name) ? 'desktop' : null;
    const format = byFolder || (['wallpaper', 'background'].includes(k) && dims ? (Number(dims[2]) > Number(dims[1]) ? 'phone' : 'desktop') : null);
    // A motion pack has "Core think.webm" twice: the reaction clip and the video sticker.
    // Animation packs (store 0.22) carry Broad/<clip> versions for broad-shouldered bodies under the same file names.
    const broad = k === 'animation' && /(^|\/)broad\//i.test(f.name);
    const wanted = broad ? `broad ${path.basename(f.name)}` : k === 'video-sticker' && !/\ssticker\.[a-z0-9]+$/i.test(f.name) ? `sticker ${path.basename(f.name)}` : format && byFolder ? `${format} ${path.basename(f.name)}` : f.name;
    let name = safeName(wanted);
    for (let i = 2; seen.has(name.toLowerCase()); i++) name = safeName(`${path.parse(wanted).name} ${i}${path.extname(wanted)}`);
    seen.add(name.toLowerCase());
    const file = { name, kind: k, mime: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', buffer: bytes };
    if (format) file.format = format;
    out.push(file);
  }
  return out;
}

/** A model's facts from its own glTF header. Throws when the file is not a VRM. */
export function readVrmInfo(buffer) {
  if (buffer.length < 20 || buffer.subarray(0, 4).toString('latin1') !== 'glTF') throw new Error('not a glTF binary');
  const length = buffer.readUInt32LE(12);
  if (buffer.subarray(16, 20).toString('latin1') !== 'JSON' || 20 + length > buffer.length) throw new Error('no glTF JSON chunk');
  const gltf = JSON.parse(buffer.subarray(20, 20 + length).toString('utf8'));
  const ext = gltf.extensions || {};
  const v1 = ext.VRMC_vrm;
  const v0 = ext.VRM;
  if (!v1 && !v0) throw new Error('a glTF model with no VRM data');
  if (v1) {
    const ex = v1.expressions || {};
    return {
      vrmVersion: '1.0',
      title: v1.meta?.name || '',
      expressions: [...Object.keys(ex.preset || {}), ...Object.keys(ex.custom || {})].sort(),
      boneCount: Object.keys(v1.humanoid?.humanBones || {}).length,
      springBoneCount: (ext.VRMC_springBone?.springs || []).length
    };
  }
  return {
    vrmVersion: '0.x',
    title: v0.meta?.title || '',
    expressions: (v0.blendShapeMaster?.blendShapeGroups || []).map(g => g.presetName || g.name).filter(Boolean).sort(),
    boneCount: (v0.humanoid?.humanBones || []).length,
    springBoneCount: (v0.secondaryAnimation?.boneGroups || []).length
  };
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/**
 * Put a bought model in the gallery. Its id is store-<variant>, so it can never replace a model that was not bought.
 * Installing twice updates the one entry. Returns the manifest entry.
 */
export async function installVrm(buffer, { variant, name, description = '' }, vrmDir) {
  const info = readVrmInfo(buffer);
  const id = `store-${String(variant).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
  const file = `${id}.vrm`;
  await fs.mkdir(vrmDir, { recursive: true });
  await writeAtomic(path.join(vrmDir, file), buffer);
  const entry = {
    id, name: name || info.title || id, file,
    sizeMB: Math.round(buffer.length / 104857.6) / 10,
    vrmVersion: info.vrmVersion, expressions: info.expressions, boneCount: info.boneCount, springBoneCount: info.springBoneCount,
    description: description || 'Bought from Bots & Borgs', source: 'botsandborgs'
  };
  await addToManifest(entry, vrmDir);
  return entry;
}

/** Add or update a manifest entry. An unreadable manifest is an error: writing over it would empty the gallery. */
export async function addToManifest(entry, vrmDir) {
  const file = path.join(vrmDir, 'manifest.json');
  let list = [];
  try {
    list = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error('not a list');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`The model gallery's manifest can't be read (${e.message}), so it was left alone.`);
  }
  const at = list.findIndex(m => m.id === entry.id);
  if (at >= 0) list[at] = entry; else list.push(entry);
  await writeAtomic(file, JSON.stringify(list, null, 2));
}

/**
 * What a clip is for, from its name: the playground plays a bought "wave" when the agent says hello, and so on.
 * The names come from the store's packs (wave, bow, cheer, clap, laugh, dance groove, rumba, dab, …).
 */
export function clipGesture(label) {
  const n = String(label || '').toLowerCase();
  // "Waving" drops the e: it matched nothing and a random clip was filmed (Booty Shake, 2026-11-15).
  if (/\bwav(?:e|es|ed|ing)\b|hello|greet/.test(n)) return 'wave';
  if (/\bbow/.test(n)) return 'bow';
  if (/\bcheer/.test(n)) return 'cheer';
  if (/\bclap/.test(n)) return 'clap';
  if (/\blaugh/.test(n)) return 'laugh';
  if (/\bdab\b/.test(n)) return 'dab';
  if (/danc|groove|rumba|belly|can.?can|cabbage|running man|roger|gogo|go.?go|booty|shake|twerk|samba|ballet|hip.?hop/.test(n)) return 'dance';
  return null;
}

/**
 * The prop a clip needs, which the store does not ship: the pole dance grips a vertical pole about 4.5 cm wide,
 * 0.40 m to the avatar's right (X -0.40, Z 0, avatar at the origin facing +Z; BotsAndBorgs vrm-pole-dance).
 */
export function clipProp(words) {
  return /\bpole\b/i.test(String(words || '').replace(/-/g, ' ')) ? { type: 'pole', x: -0.40, z: 0, radius: 0.0225, height: 3 } : null;
}

/** A clip's facts from its own glTF header: the expressions it moves. Throws when the file is not a VRM animation. */
export function readVrmaInfo(buffer) {
  if (buffer.length < 20 || buffer.subarray(0, 4).toString('latin1') !== 'glTF') throw new Error('not a glTF binary');
  const length = buffer.readUInt32LE(12);
  if (buffer.subarray(16, 20).toString('latin1') !== 'JSON' || 20 + length > buffer.length) throw new Error('no glTF JSON chunk');
  const gltf = JSON.parse(buffer.subarray(20, 20 + length).toString('utf8'));
  const ext = gltf.extensions?.VRMC_vrm_animation;
  if (!ext) throw new Error('a glTF file with no VRM animation data');
  const ex = ext.expressions || {};
  return {
    bones: Object.keys(ext.humanoid?.humanBones || {}).length,
    expressions: [...Object.keys(ex.preset || {}), ...Object.keys(ex.custom || {})].sort()
  };
}

/** A clip's label from its file name: "rumba.vrma" → "Rumba", "dance_groove-120bpm.vrma" → "Dance groove 120bpm". */
export function clipLabel(name) {
  const t = path.parse(String(name || '')).name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Clip';
}

/** Loops unless it is a one-shot gesture. The store's README or the item's own list wins when it names them. */
export function clipLoops(label, loops = null) {
  const n = String(label || '').toLowerCase();
  if (Array.isArray(loops) && loops.length) return loops.some(l => n.includes(String(l).toLowerCase()));
  return !/\b(wave|bow|laugh|dab|hello|goodbye|greet)\b/.test(n);
}

/**
 * The bought clips the designer and the playground load: data/vrm-models/animations/store.json, rebuilt whole from the
 * library every time, so it can't drift from what was bought. Each clip is copied to animations/store/<variant>/. The
 * repo's animations.json is never touched (it is the agent's own list, and nothing bought goes into it).
 * A clip is used on this machine only: the store's licence allows no resale or sharing of the files.
 */
/** A clip's meaning from its clips.json tags, in the gesture words the players use. */
export function tagGesture(tags = []) {
  const t = new Set((tags || []).map(x => String(x).toLowerCase()));
  if (['greet', 'wave', 'hello', 'goodbye'].some(x => t.has(x))) return 'wave';
  if (t.has('bow')) return 'bow';
  if (t.has('clap')) return 'clap';
  if (t.has('laugh')) return 'laugh';
  if (t.has('dab')) return 'dab';
  if (t.has('dance')) return 'dance';
  if (['cheer', 'celebrate', 'victory'].some(x => t.has(x))) return 'cheer';
  return null;
}

/**
 * clips.json (store 0.22, "bots-and-borgs clips 1") onto a pack's animation files: name, loop, seconds, tags, faces,
 * energy, while_talking, bodies and body_fit. "Broad/x.vrma" is the file kept as "broad x.vrma". Returns the files.
 */
export function applyClipManifest(files, manifest) {
  const clips = Array.isArray(manifest?.clips) ? manifest.clips : [];
  for (const c of clips) {
    if (!c?.file) continue;
    const want = /(^|\/)broad\//i.test(c.file) ? `broad ${path.basename(c.file)}` : path.basename(c.file);
    const f = files.find(x => x.kind === 'animation' && x.name.toLowerCase() === want.toLowerCase());
    if (!f) continue;
    if (c.name) f.label = String(c.name);
    if (typeof c.loop === 'boolean') f.loop = c.loop;
    if (Number(c.seconds) > 0) f.seconds = Number(c.seconds);
    if (Array.isArray(c.tags)) f.tags = c.tags.map(String);
    for (const [from, to] of [['faces', 'faces'], ['energy', 'energy'], ['bodies', 'bodies'], ['body_fit', 'bodyFit']]) if (c[from]) f[to] = String(c[from]);
    if (typeof c.while_talking === 'boolean') f.whileTalking = c.while_talking;
    if (c.prop) f.propNote = String(c.prop);
    // Store 0.30.2 (2119 #537): a loop names its way in and out (`entry`/`exit`: "idle" or a companion clip id) and a
    // baked play-once version (`once`); companions say what they are (`role`: in | out | once) and whose (`of`).
    for (const k of ['entry', 'exit', 'once', 'of']) if (typeof c[k] === 'string' && c[k]) f[k] = c[k];
    if (['in', 'out', 'once'].includes(c.role)) f.role = c.role;
    const g = tagGesture(f.tags) || clipGesture(f.label || f.name);
    if (g) f.gesture = g; else delete f.gesture;
  }
  return files;
}

const triple = (a) => Array.isArray(a) && a.length === 3 && a.every(n => typeof n === 'number' && Number.isFinite(n));
const clipKey = (s) => String(s || '').toLowerCase().replace(/\.vrma$/, '').replace(/^broad[ /]/, '').replace(/[\s_]+/g, '-');

/**
 * attach.json ("bots-and-borgs props 1", 2119 #494) as clip key -> [attachment]. Each attachment is
 * { prop, file, kind, bone, position, rotation }, for the body fit asked (standard, else the one given). Entries without
 * a bone, three positions and three rotations are left out, never guessed.
 */
export function propAttachments(manifest, { fit = 'standard', fileFor = (f) => f } = {}) {
  const byClip = new Map();
  for (const p of Array.isArray(manifest?.props) ? manifest.props : []) {
    if (!p?.file || !p.clips || typeof p.clips !== 'object') continue;
    for (const [clip, fits] of Object.entries(p.clips)) {
      const a = fits?.[fit] || fits?.standard || (fits?.bone ? fits : null);
      if (!a || typeof a.bone !== 'string' || !triple(a.position) || !triple(a.rotation)) continue;
      const key = clipKey(clip);
      if (!byClip.has(key)) byClip.set(key, []);
      // Store 2119 #559 (Winter pack, 12-01): a placement may name its own build ("file": "santa_hat_sb.glb", one per
      // hair family); load THAT glb from the pack instead of the prop's default.
      const own = typeof a.file === 'string' && /^[\w.-]+\.glb$/i.test(path.basename(a.file)) ? a.file : null;
      const one = { prop: String(p.prop || path.basename(p.file, '.glb')), file: fileFor(own || p.file), kind: p.kind || null, bone: a.bone, position: a.position, rotation: a.rotation };
      // Store 0.28 (2119 #521): `when` = show only for that kind of video (the mic: "performance"); `use` = what it is for.
      const when = a.when ?? p.when;
      if (typeof when === 'string' && when) one.when = when;
      if (typeof p.use === 'string' && p.use) one.use = p.use.slice(0, 200);
      if (Array.isArray(p.hide)) one.hide = p.hide.filter(b => typeof b === 'string').slice(0, 30);
      // Store 2119 #539: shown only in a window of the clip, and the prop's own animation (looped or once).
      const show = a.show ?? p.show;
      if (Array.isArray(show) && show.length === 2 && show.every(n => Number.isFinite(n)) && show[1] > show[0]) one.show = show;
      for (const k of ['prop_loop', 'prop_anim']) { const v = a[k] ?? p[k]; if (v) one[k] = typeof v === 'string' ? v : v.name ? { name: String(v.name), ...(Array.isArray(v.at) && v.at.length && v.at.every(n => Number.isFinite(n) && n >= 0) ? { at: v.at.slice(0, 20) } : {}) } : undefined; }
      // Optional: a size factor, and scaling with the body (AvatarX 0.3.17, 2951 #206): scale_with "body" + ref_hips =
      // the standing hip height (m) of the body it was built on. The placement's own value wins over the prop's.
      const scale = Number(a.scale ?? p.scale);
      if (Number.isFinite(scale) && scale > 0 && scale !== 1) one.scale = scale;
      const refHips = Number(a.ref_hips ?? p.ref_hips);
      if ((a.scale_with ?? p.scale_with) === 'body' && Number.isFinite(refHips) && refHips > 0.1) Object.assign(one, { scale_with: 'body', ref_hips: refHips });
      // The pack's own "not on these bodies" for this clip (3910 #3205): [{ bodies: [store names without vrm-], clips, reason }].
      const not = (Array.isArray(p.unsupported_on) ? p.unsupported_on : [])
        .filter(e => Array.isArray(e?.bodies) && Array.isArray(e.clips) && e.clips.some(c => clipKey(c) === key))
        .map(e => ({ bodies: e.bodies.map(b => String(b).toLowerCase().replace(/^vrm-/, '')), reason: String(e.reason || 'it does not fit this body').slice(0, 200) }));
      if (not.length) one.unsupported_on = not;
      // Where the prop sits on a family of bodies (hand size, hair), and the build of it they wear, whatever the clip.
      const seats = Object.entries(p.families && typeof p.families === 'object' && !Array.isArray(p.families) ? p.families : {})
        .filter(([, f]) => Array.isArray(f?.bodies) && f.bodies.length && typeof f.bone === 'string' && triple(f.position) && triple(f.rotation))
        .map(([name, f]) => ({ name: name.slice(0, 64), bodies: f.bodies.map(b => String(b).toLowerCase().replace(/^vrm-/, '')), bone: f.bone, position: f.position, rotation: f.rotation,
          ...(typeof f.file === 'string' && /^[\w.-]+\.glb$/i.test(path.basename(f.file)) ? { file: path.basename(f.file) } : {}),
          ...(Number.isFinite(Number(f.scale)) && Number(f.scale) > 0 && Number(f.scale) !== 1 ? { scale: Number(f.scale) } : {}) }));
      if (seats.length) one.families = seats;
      byClip.get(key).push(one);
    }
  }
  return byClip;
}

/**
 * Every owned props pack: its .glb files copied to <vrmDir>/props/<variant>/ (served at /vrm-models/props/…) and its
 * attach.json read into clip key -> [attachment], file paths relative to vrmDir. A broken pack is skipped.
 */
async function storeProps(items, libraryDir, vrmDir, warn = () => {}) {
  const all = new Map();
  for (const item of items) {
    const manifestFile = (item.files || []).find(f => f.kind === 'prop-manifest');
    if (!manifestFile) continue;
    const variant = safeName(item.variant);
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(libraryDir, variant, manifestFile.name), 'utf8')); }
    catch (e) { warn(`${item.variant} attach.json unreadable: ${e.message}`); continue; }
    const dest = path.join(vrmDir, 'props', variant);
    const have = new Map((item.files || []).filter(f => f.kind === 'prop').map(f => [path.basename(f.name).toLowerCase(), f.name]));
    const copied = new Set();
    for (const [key, list] of propAttachments(manifest, { fileFor: (f) => path.basename(String(f)) })) {
      for (const a of list) {
        const name = have.get(a.file.toLowerCase());
        if (!name) { warn(`${item.variant}: attach.json names ${a.file}, not in the pack`); continue; }
        if (!copied.has(name)) {
          const bytes = await fs.readFile(path.join(libraryDir, variant, name)).catch(() => null);
          if (!bytes) { warn(`${item.variant}: ${name} missing from the library`); continue; }
          await fs.mkdir(dest, { recursive: true });
          const to = path.join(dest, name);
          if (!(await fs.readFile(to).then(b => b.equals(bytes)).catch(() => false))) await writeAtomic(to, bytes);
          copied.add(name);
        }
        // The builds its families wear come along; a seat whose build is not in the pack is left out.
        const families = [];
        for (const f of a.families || []) {
          if (!f.file) { families.push(f); continue; }
          const build = have.get(f.file.toLowerCase());
          const bytes = build && await fs.readFile(path.join(libraryDir, variant, build)).catch(() => null);
          if (!bytes) { warn(`${item.variant}: attach.json names ${f.file} for ${f.name}, not in the pack`); continue; }
          if (!copied.has(build)) { await fs.mkdir(dest, { recursive: true }); await writeAtomic(path.join(dest, build), bytes); copied.add(build); }
          families.push({ ...f, file: build });
        }
        const { families: _f, ...kept } = a;
        if (!all.has(key)) all.set(key, []);
        all.get(key).push({ ...kept, ...(families.length ? { families } : {}), file: `props/${variant}/${name}`, variant: item.variant });
      }
    }
  }
  return all;
}

// Props shown only when asked (the owner, 2026-11-15): the store hangs a mic stand on the talk loops, which this agent
// plays under every spoken line; a mic in front of it every time was not wanted. These props show only when a request
// names them (or a podcast/stage), or the scene is a studio. Others show whenever their clip plays.
// Since store 0.28 a placement says so itself (`when`, e.g. "performance"); this list covers packs from before it.
export const PROPS_ON_REQUEST = ['mic'];
const ON_REQUEST_WORDS = { mic: /\b(mic|mike|microphone|podcast|on air|stage|sing|singing|karaoke|studio|booth|broadcast)\b/i };
// A `when: "performance"` prop: a stand-up bit, a song, hosting a show (the owner's rule: never for ordinary talking).
const WHEN_WORDS = { performance: /\b(perform\w*|stand[- ]?up|comedy|sing|singing|song|karaoke|host\w*|stage|concert|podcast|on air|broadcast|mic|mike|microphone|studio|booth)\b/i };

/** Why a pack says this prop placement is not for a body (its store name without vrm-), or null. The first match wins. */
export function notOnBody(prop, body) {
  if (!body) return null;
  return (prop?.unsupported_on || []).find(e => e.bodies.includes(String(body).toLowerCase()))?.reason || null;
}

/** A prop placement as this body wears it: its family's seat and build when the pack names one, else as listed. */
export function seatFor(prop, body) {
  const f = body ? (prop?.families || []).find(x => x.bodies.includes(String(body).toLowerCase())) : null;
  if (!f) return prop;
  const { scale, scale_with, ref_hips, ...rest } = prop; // the seat's own size, as the pack says
  return { ...rest, bone: f.bone, position: f.position, rotation: f.rotation, ...(f.scale ? { scale: f.scale } : {}),
    ...(f.file ? { file: path.posix.join(path.posix.dirname(String(prop.file)), f.file) } : {}) };
}

/** A clip's props for one request: on-request props only when the request or the scene asks for them. */
export function propsFor(props, { asked = '', scene = '' } = {}) {
  return (Array.isArray(props) ? props : []).filter(p => {
    if (!p.onRequest) return true;
    const own = ON_REQUEST_WORDS[p.prop] || new RegExp(`\\b${String(p.prop).replace(/[^a-z0-9]/gi, '')}\\b`, 'i');
    const tests = [own, ...(p.when && WHEN_WORDS[p.when] ? [WHEN_WORDS[p.when]] : [])];
    return tests.some(w => w.test(String(asked)) || w.test(path.basename(String(scene || ''))));
  });
}

export async function writeStoreAnimations(items, libraryDir, vrmDir, { warn, onRequest = PROPS_ON_REQUEST } = {}) {
  const out = [];
  const props = await storeProps(items, libraryDir, vrmDir, warn).catch(() => new Map());
  for (const item of items) {
    // Broad-shouldered versions stay off the list: the store's own models are standard bodies.
    const clips = (item.files || []).filter(f => f.kind === 'animation' && f.bodyFit !== 'broad');
    if (!clips.length) continue;
    const variant = safeName(item.variant);
    const dest = path.join(vrmDir, 'animations', 'store', variant);
    await fs.mkdir(dest, { recursive: true });
    for (const f of clips) {
      const to = path.join(dest, f.name);
      // Same bytes, not same size: a reissued clip often keeps its size (Rumba, react-victory, 2026-11-10).
      const bytes = await fs.readFile(path.join(libraryDir, variant, f.name)).catch(() => null);
      if (!bytes) continue;
      const there = await fs.readFile(to).then(b => b.equals(bytes)).catch(() => false);
      if (!there) await writeAtomic(to, bytes);
      const label = f.label || clipLabel(f.name);
      const entry = { file: `store/${variant}/${f.name}`, label, group: `Bots & Borgs: ${item.title || item.variant}`, loop: f.loop ?? clipLoops(label), source: 'botsandborgs', variant: item.variant };
      const gesture = f.gesture || clipGesture(label);
      if (gesture) entry.gesture = gesture;
      const prop = f.prop || clipProp(`${label} ${item.title || ''} ${item.variant}`);
      if (prop) entry.prop = prop;
      // Owned props for this clip (a props pack's attach.json keys clips by file name: "phone-call-loop").
      const held = props.get(clipKey(f.name)) || props.get(clipKey(label));
      if (held?.length) {
        entry.props = held.map(p => (onRequest.includes(p.prop) || p.when ? { ...p, onRequest: true } : p));
        // What the clip is for, from its props' `use` lines ("drinking coffee: mug-sip-idle"): clip choice reads them.
        const uses = [...new Set(held.map(p => p.use).filter(Boolean))];
        if (uses.length) entry.uses = uses;
      }
      if (f.expressions?.length) entry.expressions = f.expressions;
      for (const k of ['tags', 'faces', 'energy', 'whileTalking', 'seconds', 'bodies', 'entry', 'exit', 'once', 'role', 'of']) if (f[k] != null) entry[k] = f[k];
      out.push(entry);
    }
  }
  await fs.mkdir(path.join(vrmDir, 'animations'), { recursive: true });
  await writeAtomic(path.join(vrmDir, 'animations', 'store.json'), JSON.stringify(out, null, 2));
  return out;
}

/** A picture as a Telegram sticker: 512 px on its longest side, WebP, transparency kept. */
export async function toStickerWebp(buffer) {
  const { default: sharp } = await import('sharp');
  return sharp(buffer).resize(512, 512, { fit: 'inside' }).webp({ quality: 90 }).toBuffer();
}

/**
 * A square avatar from a model's store preview. A preview is a wide turnaround sheet (front, three-quarter, back, …,
 * with the name top left), and a centre crop of it showed the model from behind (DELTA's Sentinel, 2026-11-07).
 * The first figure from the left is the front view: crop a square around it. A preview that is not wide is returned as is.
 */
export async function portraitFromPreview(buffer) {
  const { default: sharp } = await import('sharp');
  const img = sharp(buffer).rotate();
  const { width: W, height: H } = await img.metadata();
  if (!W || !H || W / H < 1.25) return buffer;
  const { data, info } = await img.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const px = (x, y) => (y * W + x) * ch;
  const bg = [0, 1, 2].map(c => data[px(W - 1, H - 1) + c]);
  const ink = (x, y) => { const i = px(x, y); return Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 40; };
  const top = Math.floor(H * 0.12); // below the name label
  const colInk = (x) => { let n = 0; for (let y = top; y < H; y += 2) if (ink(x, y)) n++; return n; };
  const minInk = Math.max(3, Math.floor((H - top) / 2 * 0.05));
  let x0 = -1, x1 = -1;
  for (let x = 0; x < W; x++) {
    const on = colInk(x) >= minInk;
    if (on && x0 < 0) x0 = x;
    if (!on && x0 >= 0) { x1 = x - 1; break; }
  }
  if (x0 < 0) return buffer;
  if (x1 < 0) x1 = W - 1;
  let y0 = H, y1 = -1;
  for (let y = top; y < H; y++) for (let x = x0; x <= x1; x += 2) if (ink(x, y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
  if (y1 < 0) return buffer;
  // The figure alone (never a slice of its neighbour), then padded to a square in the sheet's own background.
  let next = W;
  for (let x = x1 + 1; x < W; x++) if (colInk(x) >= minInk) { next = x; break; }
  const m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.08);
  const left = Math.max(0, x0 - m), right = Math.min(W - 1, x1 + m, Math.floor((x1 + next) / 2));
  const up = Math.max(top, y0 - m), down = Math.min(H - 1, y1 + m);
  const w = right - left + 1, h = down - up + 1, side = Math.max(w, h);
  const padX = side - w, padY = side - h;
  return sharp(buffer).rotate().extract({ left, top: up, width: w, height: h })
    .extend({ left: Math.floor(padX / 2), right: Math.ceil(padX / 2), top: Math.floor(padY / 2), bottom: Math.ceil(padY / 2), background: { r: bg[0], g: bg[1], b: bg[2] } })
    .png().toBuffer();
}

/** A set's spec (bnb-set/1) when it is one this renderer can film in, else null. */
export function readSetSpec(json) {
  let s; try { s = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!s || s.format !== 'bnb-set/1' || !['mesh', 'equirect'].includes(s.kind) || !s.file || typeof s.file !== 'string') return null;
  const ext = path.extname(s.file).toLowerCase();
  if (s.kind === 'mesh' ? ext !== '.glb' : !['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return null;
  return s;
}

// Words that say nothing about which set it is, whether in its title or its tags.
const SET_PLAIN = new Set(['360', 'set', 'scene', 'the', 'and', 'room', 'day', 'night', 'evening', 'place', 'field', 'final', 'dance', 'talk', 'indoor', 'outdoor', 'wood', 'calm', 'nature', 'water']);
const setWords = (t) => String(t || '').toLowerCase().replace(/cosy/g, 'cozy').match(/[a-z0-9]+/g) || [];
const SET_AT = '(?:in|on|at|inside|into|onto|from|with|behind|under|beneath|by|near|through)';

/**
 * The set a request names ("dancing on the Sunset Beach", "in the cozy room in the evening"), or null. Its whole title, or
 * a telling word of it after in / on / at; a tag counts too, but less than a title ("the cozy room" is the Cozy Room, not
 * the Attic Loft that is tagged cozy, 2026-11-25). Of two that fit alike the one whose other words are said, else the first.
 */
export function setNamed(asked, sets) {
  const said = ` ${setWords(asked).join(' ')} `;
  const has = (w) => said.includes(` ${w} `) || (w.length > 3 && said.includes(` ${w}s `));
  const at = (w) => new RegExp(` ${SET_AT}(?: [a-z0-9]+){0,3} ${w}s? `).test(said);
  const scored = sets.map((x) => {
    const title = setWords(x.spec.title || x.spec.id);
    const bare = title.filter(w => w !== '360' && w !== 'set' && w !== 'the').join(' ');
    const heard = title.filter(has);
    // A short word ("red", "tea") is a place only beside another word of the same title ("red planet", "tea room").
    const words = [...new Set(title)].filter(w => !SET_PLAIN.has(w) && w.length >= 3 && at(w) && (w.length >= 4 || heard.length >= 2));
    const tags = [...new Set(Array.isArray(x.spec.tags) ? x.spec.tags.flatMap(setWords) : [])].filter(w => !SET_PLAIN.has(w) && w.length >= 3 && !title.includes(w) && at(w));
    const whole = bare && has(bare) ? 100 : 0;
    const score = whole || words.length || tags.length ? whole + words.length * 10 + tags.length * 3 + heard.length * 2 : 0;
    return { x, score };
  }).filter(s => s.score).sort((a, b) => b.score - a.score);
  return scored[0]?.x || null;
}
