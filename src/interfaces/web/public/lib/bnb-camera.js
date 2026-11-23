// Camera moves, bnb-camera/1 (agreed with Bots & Borgs, 2026-11-22): data only, no three.js, so the page and the tests
// share it. yaw: degrees around the body, 0 = in front (+Z), + = the avatar's left (+X), not wrapped (360 = a full
// turn). height, distance (horizontal) and look are in the body's REST height (floor to the top of the head); fov is
// vertical degrees; t runs 0..1 over the shot.

const EASE = { linear: x => x, in: x => x * x, out: x => 1 - (1 - x) * (1 - x), inOut: x => x * x * (3 - 2 * x) };
const FIELDS = { yaw: [-1080, 1080], height: [0, 4], distance: [0.3, 12], look: [0, 2], fov: [10, 90] };

/** null when the move is a usable bnb-camera/1, else what is wrong with it. */
export function moveProblem(m) {
  if (m?.format !== 'bnb-camera/1') return 'not a bnb-camera/1';
  const k = m.keys;
  if (!Array.isArray(k) || k.length < 1 || k.length > 64) return 'needs 1 to 64 keys';
  for (let i = 0; i < k.length; i++) {
    for (const [f, [lo, hi]] of Object.entries(FIELDS)) if (!(Number.isFinite(k[i]?.[f]) && k[i][f] >= lo && k[i][f] <= hi)) return `key ${i}: ${f} out of range`;
    if (!(Number.isFinite(k[i].t) && k[i].t >= 0 && k[i].t <= 1) || (i && k[i].t <= k[i - 1].t)) return `key ${i}: t must rise from 0 to 1`;
    if (k[i].ease != null && !EASE[k[i].ease]) return `key ${i}: unknown ease`;
  }
  return null;
}

/** The move at t (0..1): { yaw, height, distance, look, fov }. Held before the first key and after the last. */
export function moveAt(m, t) {
  const k = m.keys;
  const pick = (x) => ({ yaw: x.yaw, height: x.height, distance: x.distance, look: x.look, fov: x.fov });
  if (t <= k[0].t) return pick(k[0]);
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i].t) {
      const a = k[i - 1], b = k[i];
      const x = EASE[a.ease || 'linear']((t - a.t) / (b.t - a.t));
      const out = {};
      for (const f of Object.keys(FIELDS)) out[f] = a[f] + (b[f] - a[f]) * x;
      return out;
    }
  }
  return pick(k[k.length - 1]);
}

/**
 * A move as a place allows it. A turn wider than the arc would jump from one end to the other when clamped, so it
 * becomes one sweep across the arc, from the side the move starts towards.
 */
export function moveWithin(m, arc) {
  if (!m || !Array.isArray(arc) || arc[1] - arc[0] >= 360) return m;
  const yaws = m.keys.map(k => k.yaw);
  if (Math.max(...yaws) - Math.min(...yaws) < 180 && yaws.every(y => Math.abs(y) <= 180)) {
    return { ...m, keys: m.keys.map(k => ({ ...k, yaw: Math.min(Math.max(k.yaw, arc[0]), arc[1]) })) };
  }
  const up = yaws[yaws.length - 1] >= yaws[0];
  const first = m.keys[0], last = m.keys[m.keys.length - 1];
  return { ...m, loop: false, keys: [{ ...first, t: 0, yaw: up ? arc[0] : arc[1], ease: 'inOut' }, { ...last, t: 1, yaw: up ? arc[1] : arc[0] }] };
}

const norm = (d) => ((d % 360) + 540) % 360 - 180;

/** A view in metres, for a body of rest height H, pulled back by `pull` and kept inside a set's camera limits. */
export function viewFor(v, H, { pull = 1, limits = null } = {}) {
  let yaw = v.yaw, distance = v.distance * H * pull, height = v.height * H;
  if (limits) {
    const [a0, a1] = limits.arc_deg || [-180, 180];
    if (a1 - a0 < 360) { const y = norm(yaw); yaw = Math.min(Math.max(y, a0), a1); }
    if (limits.distance_m) distance = Math.min(Math.max(distance, limits.distance_m[0]), limits.distance_m[1]);
    if (limits.height_m) height = Math.min(Math.max(height, limits.height_m[0]), limits.height_m[1]);
  }
  const r = yaw * Math.PI / 180;
  return { yaw, fov: v.fov, x: Math.sin(r) * distance, y: height, z: Math.cos(r) * distance, lookY: v.look * H, distance };
}

/** Whether a set's wall is hidden from this yaw: `when_camera_deg` may wrap past 180. */
export function hiddenAt(range, yaw) {
  if (!Array.isArray(range) || range.length !== 2) return false;
  const y = norm(yaw), a = norm(range[0]), b = norm(range[1]);
  if (range[1] - range[0] >= 360) return true;
  return a <= b ? y >= a && y <= b : y >= a || y <= b;
}

/**
 * How far the whole move must pull back (>= 1) so a box (its 8 corners, metres, around the body's floor point) stays in
 * frame at every moment. `aspect` is width / height; margin 1.08 leaves air around it. Never past what the set allows.
 */
export function pullFor(m, H, corners, aspect, { limits = null, margin = 1.08, steps = 24, max = 4 } = {}) {
  const fits = (pull) => {
    for (let i = 0; i <= steps; i++) {
      const v = viewFor(moveAt(m, i / steps), H, { pull, limits });
      // Camera axes: forward from the camera to the look point, right level with the floor.
      let f = [-v.x, v.lookY - v.y, -v.z]; const fl = Math.hypot(...f); f = f.map(n => n / fl);
      const rl = Math.hypot(f[0], f[2]) || 1e-9; const rt = [-f[2] / rl, 0, f[0] / rl];
      const up = [rt[1] * f[2] - rt[2] * f[1], rt[2] * f[0] - rt[0] * f[2], rt[0] * f[1] - rt[1] * f[0]];
      const tan = Math.tan(v.fov * Math.PI / 360);
      for (const c of corners) {
        const d = [c[0] - v.x, c[1] - v.y, c[2] - v.z];
        const depth = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
        if (depth <= 0.05) return false;
        if (Math.abs(d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) * margin > depth * tan) return false;
        if (Math.abs(d[0] * rt[0] + d[1] * rt[1] + d[2] * rt[2]) * margin > depth * tan * aspect) return false;
      }
    }
    return true;
  };
  if (fits(1)) return 1;
  let lo = 1, hi = max;
  for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  return hi;
}
