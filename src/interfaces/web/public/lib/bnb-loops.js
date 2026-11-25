/**
 * The moving parts of a 3D set (bnb-set/1 `loops`, 3910 #6035): screens that change picture ("frames"), lights that breathe
 * ("pulse"), things that sway. Everything follows the time since the set is shown, so a video and a live page agree.
 * Pure functions of `t` (seconds); applyLoops puts them on a loaded three.js set. A loop that is not understood, or whose
 * node is not there, is left still.
 */
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Is this a loop we play? Out-of-range values are never clamped into something else: the part stays still. */
export function goodLoop(l) {
  if (!l || typeof l !== 'object' || typeof l.node !== 'string' || !l.node) return false;
  if (l.type === 'frames') return Number.isInteger(l.count) && num(l.count, 2, 32) && num(l.fps, 1, 12) && Number.isInteger(l.cols) && num(l.cols, 1, 32) && num(l.du, -1, 1) && num(l.dv, -1, 1);
  if (l.type === 'pulse') return num(l.min, 0, 1.5) && num(l.max, 0, 1.5) && num(l.period_s, 0.5, 20) && num(l.phase ?? 0, 0, 1);
  if (l.type === 'sway') return Array.isArray(l.axis) && l.axis.length === 3 && l.axis.every(n => num(n, -1, 1)) && num(l.amount_m, 0, 0.3) && num(l.period_s, 0.5, 20) && num(l.phase ?? 0, 0, 1);
  return false;
}

/** The UV shift of a "frames" loop at `t`: [u, v], glTF UV (v down). The glb's own UVs are frame 0. */
export function framesAt(l, t) {
  // A hair forward: 1 / 12 s counted up in floats must not fall just short of its frame.
  const k = Math.floor(Math.max(0, t) * l.fps + 1e-6) % l.count;
  return [(k % l.cols) * l.du, Math.floor(k / l.cols) * l.dv];
}

/** The color factor of a "pulse" at `t`. */
export function pulseAt(l, t) { return l.min + (l.max - l.min) * (0.5 - 0.5 * Math.cos(2 * Math.PI * (t / l.period_s + (l.phase ?? 0)))); }

/** The move of a "sway" at `t`: [x, y, z] in meters. */
export function swayAt(l, t) { const s = l.amount_m * Math.sin(2 * Math.PI * (t / l.period_s + (l.phase ?? 0))); return l.axis.map(a => a * s); }

/**
 * Make a loaded set's loops ready: each node's material (and, for frames, its texture) becomes its own, the picture itself
 * stays shared. Returns { count, at(t) }: call at(t) before each frame is drawn.
 */
export function applyLoops(root, loops) {
  const acts = [];
  for (const l of (Array.isArray(loops) ? loops : []).slice(0, 16)) {
    if (!goodLoop(l)) continue;
    const node = root.getObjectByName(l.node);
    if (!node) continue;
    if (l.type === 'sway') {
      const base = node.position.clone();
      acts.push((t) => { const [x, y, z] = swayAt(l, t); node.position.set(base.x + x, base.y + y, base.z + z); });
      continue;
    }
    const mats = [];
    node.traverse((o) => {
      if (!o.isMesh) return;
      const own = (m) => { if (m.userData.loopsOwn) { mats.push(m); return m; } const c = m.clone(); c.userData = { ...c.userData, loopsOwn: true }; mats.push(c); return c; };
      o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
    });
    if (l.type === 'frames') {
      const maps = mats.map((m) => { if (!m.map) return null; m.map = m.map.clone(); m.map.needsUpdate = true; return { tex: m.map, u: m.map.offset.x, v: m.map.offset.y }; }).filter(Boolean);
      if (maps.length) acts.push((t) => { const [u, v] = framesAt(l, t); for (const x of maps) x.tex.offset.set(x.u + u, x.v + v); });
    } else {
      const colors = mats.filter(m => m.color).map(m => ({ c: m.color, r: m.color.r, g: m.color.g, b: m.color.b }));
      if (colors.length) acts.push((t) => { const f = pulseAt(l, t); for (const x of colors) x.c.setRGB(x.r * f, x.g * f, x.b * f); });
    }
  }
  return { count: acts.length, at(t) { for (const a of acts) a(t); } };
}
