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
  // A light that turns about a point (3910 #6275).
  if (l.type === 'swing') return Array.isArray(l.pivot) && l.pivot.length === 3 && l.pivot.every(n => num(n, -100, 100)) && Array.isArray(l.axis) && l.axis.length === 3 && l.axis.every(n => num(n, -1, 1)) && Math.abs(Math.hypot(...l.axis) - 1) < 0.02
    && num(l.angle_deg, 0, 25) && l.angle_deg > 0 && num(l.period_s, 3, 20) && num(l.phase ?? 0, 0, 1);
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

/** The turn of a "swing" at `t`, in radians. */
export function swingAt(l, t) { return l.angle_deg * Math.PI / 180 * Math.sin(2 * Math.PI * (t / l.period_s + (l.phase ?? 0))); }

/** A point turned by `a` radians about an axis of length 1 through `pivot`. */
export function turnAbout([x, y, z], [px, py, pz], [ax, ay, az], a) {
  const vx = x - px, vy = y - py, vz = z - pz, c = Math.cos(a), s = Math.sin(a), d = (ax * vx + ay * vy + az * vz) * (1 - c);
  return [px + vx * c + (ay * vz - az * vy) * s + ax * d, py + vy * c + (az * vx - ax * vz) * s + ay * d, pz + vz * c + (ax * vy - ay * vx) * s + az * d];
}

/**
 * Make a loaded set's loops ready: each node's material (and, for frames, its texture) becomes its own, the picture itself
 * stays shared. Returns { count, at(t) }: call at(t) before each frame is drawn.
 */
export function applyLoops(root, loops, beams = []) {
  const acts = [], moving = new Map();
  let played = 0;
  // At most 16 loops, and the swings of up to 8 beams besides, listed last (the store's format, 2119 #676).
  const beamSet = new Set((Array.isArray(beams) ? beams : []).slice(0, 8));
  const all = Array.isArray(loops) ? loops : [];
  const plain = all.filter(l => !(l?.type === 'swing' && beamSet.has(l?.node))).slice(0, 16);
  const beamSwings = all.filter(l => l?.type === 'swing' && beamSet.has(l?.node)).slice(0, 8);
  for (const l of [...plain, ...beamSwings]) {
    if (!goodLoop(l)) continue;
    const node = root.getObjectByName(l.node);
    if (!node) continue;
    if (l.type === 'sway' || l.type === 'swing') {
      // All that moves one node together: turned first, then moved. One swing a node.
      const m = moving.get(node) || { base: [node.position.x, node.position.y, node.position.z], turned: node.quaternion?.clone?.() || null, sways: [], swing: null };
      if (l.type === 'swing' && (m.swing || !m.turned)) continue;
      if (l.type === 'sway') m.sways.push(l);
      else {
        // The pivot is in the set's own coordinates: here it is in the node's parent's.
        const at = [...l.pivot];
        for (let o = node.parent; o && o.parent && o.parent !== root; o = o.parent) { at[0] -= o.position.x; at[1] -= o.position.y; at[2] -= o.position.z; }
        m.swing = { l, at, axis: { x: l.axis[0], y: l.axis[1], z: l.axis[2] }, q: node.quaternion.clone() };
      }
      if (!moving.has(node)) {
        moving.set(node, m);
        acts.push((t) => {
          let pos = m.base;
          if (m.swing) { const a = swingAt(m.swing.l, t); pos = turnAbout(pos, m.swing.at, m.swing.l.axis, a); node.quaternion.copy(m.swing.q.setFromAxisAngle(m.swing.axis, a)).multiply(m.turned); }
          let [x, y, z] = pos;
          for (const w of m.sways) { const [dx, dy, dz] = swayAt(w, t); x += dx; y += dy; z += dz; }
          node.position.set(x, y, z);
        });
      }
      played++;
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
      if (maps.length && ++played) acts.push((t) => { const [u, v] = framesAt(l, t); for (const x of maps) x.tex.offset.set(x.u + u, x.v + v); });
    } else {
      const colors = mats.filter(m => m.color).map(m => ({ c: m.color, r: m.color.r, g: m.color.g, b: m.color.b }));
      if (colors.length && ++played) acts.push((t) => { const f = pulseAt(l, t); for (const x of colors) x.c.setRGB(x.r * f, x.g * f, x.b * f); });
    }
  }
  return { count: played, at(t) { for (const a of acts) a(t); } };
}

/**
 * A set's light beams (`beams`: node names): drawn after everything else, never hiding what is behind them, throwing no
 * shadow. Returns how many there are. A node that is not see-through is left as it is.
 */
export function readyBeams(root, names) {
  let n = 0;
  for (const name of (Array.isArray(names) ? names : []).slice(0, 8)) {
    root.getObjectByName(name)?.traverse((o) => {
      if (!o.isMesh || !o.material?.transparent) return;
      o.material.depthWrite = false; o.renderOrder = 10; o.castShadow = false; o.receiveShadow = false; n++;
    });
  }
  return n;
}
