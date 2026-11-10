/**
 * What a bought store download holds, and where it goes. A download is one file or a zip of any layout;
 * each file is classified by its name, then kept under data/store/<variant>/. A VRM model also goes into the
 * agent's model gallery (data/vrm-models + manifest.json), where the avatar designer and every animation can use it.
 *
 * Bought models are licensed for this agent, not for redistribution: nothing here shares them, and they stay in
 * the data directory, which is never in git.
 */
import fs from 'fs/promises';
import path from 'path';

/** "Send me a happy sticker", "wear the bear 3D model": a request for something owned, with no store name in it. */
export function asksToUseStoreItem(text) {
  const t = String(text || '');
  return /\b(send|text|give)\b.{0,60}\b(stickers?|emotes?)\b/i.test(t) || /\b(wear|switch to|become|use|install)\b.{0,40}\b(vrm|3d (?:model|avatar))\b/i.test(t);
}

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // a guard against a bad zip, not a size limit on products
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.vrm': 'model/gltf-binary', '.vrma': 'model/gltf-binary', '.webm': 'video/webm', '.mp4': 'video/mp4', '.txt': 'text/plain', '.md': 'text/markdown', '.pdf': 'application/pdf' };

/** The name a file may have on disk: its last path part, nothing that can climb out of the folder. */
export function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[^\p{L}\p{N} ._()-]+/gu, '_').replace(/^\.+/, '').trim();
  return base.slice(0, 120) || 'file';
}

/** What a variant is, from the store's own naming: a slug suffix, then the product's collection. */
export function variantKind(variant, collection = '') {
  const id = String(variant || '');
  if (/-bundle$/.test(id)) return 'bundle';
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
  if (/\.(txt|md|pdf)$/.test(n) || /(^|\/)(readme|licen[cs]e|credits)/.test(n)) return 'document';
  if (!/\.(png|jpe?g|webp|gif|webm|mp4)$/.test(n)) return null;
  if (/preview|thumbnail|contact.?sheet/.test(n)) return 'preview';
  // An animation pack's pictures and videos only show its clips.
  if (kind === 'animation') return 'preview';
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
  if (kind === 'sticker') {
    const word = /\s([a-z]+)$/i.exec(base)?.[1]?.toLowerCase();
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
    const ext = path.extname(filename) || (/png/i.test(type) ? '.png' : /jpe?g/i.test(type) ? '.jpg' : /webp/i.test(type) ? '.webp' : buffer.subarray(0, 4).toString('latin1') === 'glTF' ? '.vrm' : '');
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
    // A wallpaper pack holds the same scene under desktop/ and phone/, so the folder goes in the name.
    const format = /(^|\/)phone\//i.test(f.name) ? 'phone' : /(^|\/)desktop\//i.test(f.name) ? 'desktop' : null;
    const wanted = format ? `${format} ${path.basename(f.name)}` : f.name;
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
  if (/\bwave|hello|greet/.test(n)) return 'wave';
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
export async function writeStoreAnimations(items, libraryDir, vrmDir) {
  const out = [];
  for (const item of items) {
    const clips = (item.files || []).filter(f => f.kind === 'animation');
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
      if (f.expressions?.length) entry.expressions = f.expressions;
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
