// LANAgent: copied from AvatarX web/src/lite.js (0.4.17, MIT, e17b2fe).
// A big body made light enough for the device that shows it, as it loads (the file on the server is never changed):
// - shape keys: only the ones an expression or the worn look uses are loaded (a scan may carry thousands, each one
//   memory for every vertex, in the page and again on the graphics chip);
// - pieces the look hides are not loaded, nor the textures only they use;
// - textures are scaled down, colour maps last, until they fit the device's budget.
// OnePlus's memory guard killed the app again and again on a 197 MB body (2026-11-23): 2.5 GB of textures, 9,555 shape
// keys, 54 of them used.
const MB = 1e6;
const MAGIC = 0x46546c67;

// Texture memory a page may take on the graphics chip (the page holds about as much again).
export function textureBudget({ render = false, ua = navigator.userAgent, mobile = navigator.userAgentData?.mobile, gb = navigator.deviceMemory } = {}) {
  if (mobile || /Android|iPhone|iPad|iPod|Quest|OculusBrowser/i.test(ua)) return (!gb || gb >= 8 ? 400 : gb >= 4 ? 250 : 150) * MB;
  if (render) return 600 * MB;
  return (gb && gb <= 4 ? 500 : 1200) * MB;
}

// Width and height from an image's first bytes (PNG, JPEG, WebP); null when it is something else.
export function imageSize(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && v.getUint32(0) === 0x89504e47) return [v.getUint32(16), v.getUint32(20)];
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [v.getUint16(i + 7), v.getUint16(i + 5)];
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
      i += 2 + v.getUint16(i + 2);
    }
    return null;
  }
  if (b.length > 30 && v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) {
    const t = v.getUint32(12);
    if (t === 0x56503858) return [1 + (b[24] | b[25] << 8 | b[26] << 16), 1 + (b[27] | b[28] << 8 | b[29] << 16)];
    if (t === 0x5650384c) { const x = v.getUint32(21, true); return [(x & 0x3fff) + 1, ((x >> 14) & 0x3fff) + 1]; }
    if (t === 0x56503820) return [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff];
  }
  return null;
}

// The shape keys each mesh needs: the expressions' and the look's own. null: keep all of that mesh's.
function neededTargets(j, look) {
  const need = new Map();
  const add = (mesh, i) => { if (mesh != null) (need.get(mesh) || need.set(mesh, new Set()).get(mesh))?.add(i); };
  const ex = j.extensions?.VRMC_vrm?.expressions || {};
  for (const group of [ex.preset, ex.custom]) for (const e of Object.values(group || {})) for (const b of e?.morphTargetBinds || []) add(j.nodes[b.node]?.mesh, b.index);
  for (const g of j.extensions?.VRM?.blendShapeMaster?.blendShapeGroups || []) for (const b of g.binds || []) add(b.mesh, b.index);
  const names = new Set(Object.keys(look?.morphs || {}));
  (j.meshes || []).forEach((m, mi) => {
    const list = m.extras?.targetNames || m.primitives.find((p) => p.extras?.targetNames)?.extras.targetNames || [];
    list.forEach((n, i) => { if (names.has(n)) add(mi, i); });
  });
  // A key the file itself sets (a body shaped by it at rest): it is part of how the body looks.
  (j.meshes || []).forEach((m, mi) => (m.weights || []).forEach((w, i) => { if (w) add(mi, i); }));
  for (const n of j.nodes || []) (n.weights || []).forEach((w, i) => { if (w && n.mesh != null) add(n.mesh, i); });
  // The file's own animations may move any key of a mesh.
  for (const a of j.animations || []) for (const c of a.channels || []) if (c.target?.path === 'weights') need.set(j.nodes[c.target.node]?.mesh, null);
  return need;
}

function dropTargets(j, look) {
  const need = neededTargets(j, look);
  const map = new Map(); // mesh -> old index -> new index
  let dropped = 0;
  j.meshes.forEach((m, mi) => {
    const keep = need.get(mi);
    const counts = new Set(m.primitives.map((p) => p.targets?.length || 0));
    if (keep === null || counts.size !== 1) return;
    const n = [...counts][0];
    const list = [...(keep || [])].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
    if (!n || list.length === n) return;
    dropped += (n - list.length) * m.primitives.length;
    map.set(mi, new Map(list.map((i, k) => [i, k])));
    const pick = (a) => (Array.isArray(a) ? list.map((i) => a[i]) : a);
    for (const p of m.primitives) {
      if (list.length) p.targets = pick(p.targets); else delete p.targets;
      if (p.extras?.targetNames) p.extras.targetNames = pick(p.extras.targetNames);
    }
    if (m.extras?.targetNames) m.extras.targetNames = pick(m.extras.targetNames);
    if (m.weights) { if (list.length) m.weights = pick(m.weights); else delete m.weights; }
    for (const nd of j.nodes) if (nd.mesh === mi && nd.weights) { if (list.length) nd.weights = pick(nd.weights); else delete nd.weights; }
  });
  const ex = j.extensions?.VRMC_vrm?.expressions || {};
  for (const group of [ex.preset, ex.custom]) for (const e of Object.values(group || {})) {
    if (!e?.morphTargetBinds) continue;
    e.morphTargetBinds = e.morphTargetBinds.filter((b) => { const m = map.get(j.nodes[b.node]?.mesh); return !m || m.has(b.index); });
    for (const b of e.morphTargetBinds) { const m = map.get(j.nodes[b.node]?.mesh); if (m) b.index = m.get(b.index); }
  }
  for (const g of j.extensions?.VRM?.blendShapeMaster?.blendShapeGroups || []) {
    g.binds = (g.binds || []).filter((b) => { const m = map.get(b.mesh); return !m || m.has(b.index); });
    for (const b of g.binds) { const m = map.get(b.mesh); if (m) b.index = m.get(b.index); }
  }
  return dropped;
}

// The same rule as look.js: a piece shows when the look lists it, or by the author's default with no list.
function dropHidden(j, look) {
  const list = look && Array.isArray(look.pieces) ? look.pieces : null;
  const gone = new Set();
  j.nodes.forEach((n, i) => {
    const name = n.extras?.bnb_piece;
    if (!name || n.mesh == null) return;
    if (list ? list.includes(name) : n.extras.bnb_default_visible !== false) return;
    delete n.mesh; delete n.skin; delete n.weights;
    gone.add(i);
  });
  if (!gone.size) return 0;
  const ex = j.extensions?.VRMC_vrm?.expressions || {};
  for (const group of [ex.preset, ex.custom]) for (const e of Object.values(group || {})) if (e?.morphTargetBinds) e.morphTargetBinds = e.morphTargetBinds.filter((b) => !gone.has(b.node));
  return gone.size;
}

// Every texture an object names, with the key it is named under.
function eachTexture(o, fn, key = '') {
  if (Array.isArray(o)) { for (const x of o) eachTexture(x, fn, key); return; }
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (/texture$/i.test(k) && v && typeof v === 'object' && Number.isInteger(v.index)) fn(v.index, k);
    eachTexture(v, fn, k);
  }
}
const COLOUR = /^(baseColor|emissive|shadeMultiply|diffuse)Texture$/i;

function usedImages(j, meshes) {
  const out = new Map(); // image -> is it a colour map
  const image = (t) => j.textures?.[t]?.extensions?.EXT_texture_webp?.source ?? j.textures?.[t]?.source;
  const add = (t, colour) => { const i = image(t); if (i != null) out.set(i, out.get(i) || colour); };
  // VRM 0.x keeps its textures by plain number, per material name order: keep them all as colour maps.
  const vrm0 = j.extensions?.VRM?.materialProperties;
  for (const mi of meshes) for (const p of j.meshes[mi].primitives) {
    if (p.material == null) continue;
    eachTexture(j.materials[p.material], (t, k) => add(t, COLOUR.test(k)));
    for (const t of Object.values(vrm0?.[p.material]?.textureProperties || {})) if (Number.isInteger(t)) add(t, true);
  }
  return out;
}

// Each image's largest side, so that all fit: the biggest is halved first, and of two alike the one that is no colour map.
export const scaled = ([w, h], cap) => { const k = Math.min(1, cap / Math.max(w, h)); return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]; };
export function fitImages(images, budget) {
  const bytes = ([w, h]) => w * h * 4 * 1.334;
  const list = images.map((x) => ({ ...x, cap: Math.max(...x.size) }));
  const cost = () => list.reduce((s, x) => s + bytes(scaled(x.size, x.cap)), 0);
  const full = cost();
  let now = full;
  while (now > budget) {
    const open = list.filter((x) => x.cap > 256);
    if (!open.length) break;
    const pick = open.reduce((m, x) => { const d = bytes(scaled(x.size, x.cap)) - bytes(scaled(m.size, m.cap)); return d > 1 || (d > -1 && m.colour && !x.colour) ? x : m; });
    // A side that is no power of two goes to the next one down.
    pick.cap = 2 ** (Math.ceil(Math.log2(pick.cap)) - 1);
    now = cost();
  }
  return { caps: new Map(list.filter((x) => x.cap < Math.max(...x.size)).map((x) => [x.i, x.cap])), bytes: now, full };
}

/** A .vrm's bytes made light: {data, caps: image -> largest side, info}. Anything it does not understand is left alone. */
export function lighten(buf, { look = null, budget }) {
  const v = new DataView(buf);
  const asIs = (why) => ({ data: buf, caps: new Map(), info: { changed: false, why } });
  if (buf.byteLength < 28 || v.getUint32(0, true) !== MAGIC || v.getUint32(4, true) !== 2) return asIs('not a GLB');
  const jlen = v.getUint32(12, true);
  const at = 20 + jlen;
  const j = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jlen)));
  if (!j.meshes || !j.nodes || (j.buffers || []).length !== 1 || j.buffers[0].uri) return asIs('not one embedded buffer');
  const bin = new Uint8Array(buf, at + 8, v.getUint32(at, true));
  // A VRM 0.x names its keys by mesh and by the name of a material: left whole (no such model was there to test on).
  const dropped = j.extensions?.VRMC_vrm ? dropTargets(j, look) : 0;
  const hidden = dropHidden(j, look);
  const meshes = new Set(j.nodes.filter((n) => n.mesh != null).map((n) => n.mesh));
  const images = [];
  for (const [i, colour] of usedImages(j, meshes)) {
    const bv = j.bufferViews?.[j.images?.[i]?.bufferView];
    const size = bv && imageSize(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
    if (size) images.push({ i, colour, size });
  }
  const { caps, bytes, full } = fitImages(images, budget);
  const info = { changed: !!(dropped || hidden || caps.size), dropped, hidden, scaled: caps.size, sizes: [...caps.values()].reduce((o, c) => ({ ...o, [c]: (o[c] || 0) + 1 }), {}), textureMB: Math.round(bytes / MB), fullMB: Math.round(full / MB) };
  if (!dropped && !hidden) return { data: buf, caps, info };
  // Only the views something still names, so the rest is not held in memory. A compressed file keeps its own layout.
  if ((j.extensionsUsed || []).some((x) => /draco|meshopt/i.test(x))) return { data: buf, caps: new Map(), info: { changed: false, why: 'compressed' } };
  const views = new Set();
  const acc = new Set();
  for (const mi of meshes) for (const p of j.meshes[mi].primitives) {
    for (const a of Object.values(p.attributes)) acc.add(a);
    if (p.indices != null) acc.add(p.indices);
    for (const t of p.targets || []) for (const a of Object.values(t)) acc.add(a);
  }
  for (const s of j.skins || []) if (s.inverseBindMatrices != null) acc.add(s.inverseBindMatrices);
  for (const a of j.animations || []) for (const s of a.samplers || []) { acc.add(s.input); acc.add(s.output); }
  for (const a of acc) {
    const x = j.accessors[a];
    if (x.bufferView != null) views.add(x.bufferView);
    if (x.sparse) { views.add(x.sparse.indices.bufferView); views.add(x.sparse.values.bufferView); }
  }
  for (const i of usedImages(j, meshes).keys()) if (j.images[i]?.bufferView != null) views.add(j.images[i].bufferView);
  const thumb = j.extensions?.VRMC_vrm?.meta?.thumbnailImage;
  if (thumb != null && j.images?.[thumb]?.bufferView != null) views.add(j.images[thumb].bufferView);
  const t0 = j.textures?.[j.extensions?.VRM?.meta?.texture]?.source;
  if (t0 != null && j.images?.[t0]?.bufferView != null) views.add(j.images[t0].bufferView);
  let size = 0;
  const places = [];
  j.bufferViews.forEach((bv, i) => {
    if (!views.has(i)) { bv.byteOffset = 0; bv.byteLength = 4; delete bv.byteStride; return; }
    places.push([bv.byteOffset || 0, bv.byteLength, size]);
    bv.byteOffset = size;
    size = (size + bv.byteLength + 7) & ~7;
  });
  size = Math.max(size, 8);
  j.buffers[0].byteLength = size;
  const text = new TextEncoder().encode(JSON.stringify(j));
  const tlen = (text.length + 3) & ~3;
  const data = new ArrayBuffer(28 + tlen + size);
  const o = new DataView(data);
  o.setUint32(0, MAGIC, true); o.setUint32(4, 2, true); o.setUint32(8, data.byteLength, true);
  o.setUint32(12, tlen, true); o.setUint32(16, 0x4e4f534a, true);
  const u = new Uint8Array(data);
  u.fill(0x20, 20, 20 + tlen); u.set(text, 20);
  o.setUint32(20 + tlen, size, true); o.setUint32(24 + tlen, 0x004e4942, true);
  for (const [from, len, to] of places) u.set(bin.subarray(from, from + len), 28 + tlen + to);
  info.fileMB = Math.round(buf.byteLength / MB); info.loadedMB = Math.round(data.byteLength / MB);
  return { data, caps, info };
}

// One picture at a time: a 4096 px one takes 67 MB while it is unpacked, whatever it ends up as.
let decoding = Promise.resolve();
class CappedLoader {
  constructor(cap) { this.isImageBitmapLoader = true; this.cap = cap; }
  load(url, onLoad, _progress, onError) {
    decoding = decoding.then(async () => {
      const blob = await (await fetch(url)).blob();
      const opt = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
      if (this.cap) {
        const size = imageSize(new Uint8Array(await blob.arrayBuffer()));
        if (size && Math.max(...size) > this.cap) { const [w, h] = scaled(size, this.cap); Object.assign(opt, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }); }
      }
      onLoad(await createImageBitmap(blob, opt));
    }).catch((e) => onError?.(e));
  }
}

/** A GLTFLoader plugin that scales the images `caps` names. */
export const capTextures = (caps) => (parser) => {
  if (caps.size && typeof createImageBitmap === 'function') {
    const load = parser.loadImageSource.bind(parser);
    parser.loadImageSource = (i, loader) => load(i, new CappedLoader(caps.get(i)));
  }
  return { name: 'avatarx-lite' };
};

// A load the device did not survive (the app was killed on it): the next one gets half the memory, down to an eighth.
const KEY = 'avatarx-loading';
export function loadStarted(id) {
  try {
    const was = JSON.parse(localStorage.getItem(KEY) || 'null');
    const failed = was && was.id === id && Date.now() - was.at < 6 * 3600e3 ? Math.min(3, (was.failed || 0) + 1) : 0;
    localStorage.setItem(KEY, JSON.stringify({ id, at: Date.now(), failed }));
    return failed;
  } catch { return 0; }
}
/** It held: what failed before stays in mind (the halved budget is what worked). */
export function loadHeld(id, failed) {
  try { if (failed) localStorage.setItem(KEY, JSON.stringify({ id, at: Date.now(), failed: failed - 1 })); else localStorage.removeItem(KEY); } catch { /* private window */ }
}
