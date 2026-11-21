/**
 * The Bots & Borgs Animation API (store 0.38+, llms.txt "Animation API"): say WHAT the body does as a bnb-motion/1
 * script, the store solves it on the agent's own avatar and gates it (wrists, clearance, grip, face cover, loop seam).
 * POST /api/anim/solve → 202 { job, poll } (or 200, cached: the same avatar + script is free), GET /api/anim/jobs/<id>
 * → queued | claimed | passed | failed with a `report` and, when done, `vrma` + `preview` links.
 *
 * This module is the part that needs no network: the instructions a model writes a script from, the checks the store
 * would refuse a script on (so a bad script costs no solve), and reading a job back.
 */

export const MOTION_FORMAT = 'bnb-motion/1';
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_KEYS = 64;
export const MAX_SECONDS = 30;
export const LANDMARKS = ['nose', 'mouth', 'chin', 'brow', 'leftEye', 'rightEye', 'leftEar', 'rightEar', 'leftShoulder', 'rightShoulder',
  'crown', 'chest', 'leftBelly', 'rightBelly', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee'];
const PALMS = ['in', 'out', 'down', 'up', 'forward', 'back'];
const SHAPES = ['open', 'relaxed', 'fist', 'grip', 'point', 'thumbs_up', 'pump', 'flat'];
const ELBOWS = ['down', 'out', 'back'];
const TOP = new Set(['format', 'name', 'duration', 'loop', 'keys', 'prop', 'limits']);
const KEY_FIELDS = new Set(['t', 'hands', 'gaze', 'lean', 'head', 'expression', 'prop_target']);

/** A clip name the store takes: lower case, a-z 0-9 and hyphens, at most 64. "Wave with both hands!" → wave-with-both-hands. */
export function motionName(text) {
  const n = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return NAME_RE.test(n) ? n : 'move';
}

/** The instructions a model writes one script from. `request` is the owner's words; `props` names props it may hold. */
export function motionPrompt(request, { props = [], error = null, previous = null } = {}) {
  return [
    `Write ONE animation script for a 3D humanoid avatar, format ${MOTION_FORMAT}, for this request: "${String(request).slice(0, 400)}".`,
    'You say WHAT the body does at key times; a solver turns it into motion on the avatar, so describe poses, not bone angles.',
    'Shape: {"format":"bnb-motion/1","name":"<a-z0-9 and hyphens>","duration":<seconds, at most 30>,"loop":<true for a repeating move, false for a one-shot>,"keys":[...]}.',
    'Each key: {"t":<seconds; the first key is t 0 and the last at most duration>, and any of:',
    '  "hands": {"left"|"right": {"rest":"hang"} OR {"at":{"landmark":"<landmark>","offset":[x,y,z metres; x = the avatar\'s left(+)/right(-), y up, z forward]},',
    `      "point":[x,y,z direction the forearm points], "palm":"${PALMS.join('|')}", "shape":"${SHAPES.join('|')}", "elbow":"${ELBOWS.join('|')}"}},`,
    '  "gaze": {"camera":true}, "lean": {"forward":deg,"side":deg,"twist":deg}, "head": {"turn":deg,"bow":deg},',
    '  "expression": {"happy"|"angry"|"sad"|"relaxed"|"surprised"|"blink"|"aa"|"ih"|"ou"|"ee"|"oh": 0..1}}.',
    `Landmarks: ${LANDMARKS.join(', ')}, or leftThigh@0.5 / rightThigh@0.5 (0.0 hip .. 1.0 knee).`,
    props.length ? `Top level "prop": {"name":"<one of: ${props.slice(0, 20).join(', ')}>","hand":"left|right"} only when the request is about holding it.` : 'No "prop".',
    'A one-shot starts and ends with both hands {"rest":"hang"} so it begins and ends at idle. Use 3 to 12 keys, at most 64. Keep hands clear of the face and body (offsets of 0.08 m or more forward of a landmark). Two hands never get the same target: when they meet or are together, keep their x at least 0.08 m apart on each side (left +0.08, right -0.08), or they pass through each other\'s arms. No other fields: unknown fields are refused.',
    'Example: {"format":"bnb-motion/1","name":"wave","duration":3,"loop":false,"keys":[{"t":0,"hands":{"right":{"rest":"hang"}}},{"t":0.6,"hands":{"right":{"at":{"landmark":"rightEar","offset":[-0.17,0.02,0.1]},"point":[-0.15,1,0.1],"palm":"forward","shape":"open","elbow":"out"}},"gaze":{"camera":true},"expression":{"happy":0.9}},{"t":1.1,"hands":{"right":{"at":{"landmark":"rightEar","offset":[-0.25,0.02,0.1]},"point":[-0.35,1,0.1],"palm":"forward","shape":"open","elbow":"out"}}},{"t":1.6,"hands":{"right":{"at":{"landmark":"rightEar","offset":[-0.17,0.02,0.1]},"point":[-0.15,1,0.1],"palm":"forward","shape":"open","elbow":"out"}}},{"t":3,"hands":{"right":{"rest":"hang"}}}]}',
    error ? `Your last script was refused: ${String(error).slice(0, 400)}\nThe script was: ${JSON.stringify(previous).slice(0, 3000)}\nFix exactly that.` : '',
    'Answer with the JSON only.'
  ].filter(Boolean).join('\n');
}

/**
 * The script in a model's answer, tidied the way the store requires (format, name, keys sorted, first t 0), or
 * { error } naming what is wrong. Only fields the format has are kept, so a stray one never costs a solve.
 */
export function parseMotionScript(raw, { name = null } = {}) {
  const text = String(raw || '');
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return { error: 'no JSON in the answer' };
  let s;
  try { s = JSON.parse(text.slice(a, b + 1)); } catch (e) { return { error: `not JSON: ${e.message}` }; }
  if (!s || typeof s !== 'object' || !Array.isArray(s.keys) || !s.keys.length) return { error: 'the script has no keys' };
  const out = {};
  for (const [k, v] of Object.entries(s)) if (TOP.has(k)) out[k] = v;
  out.format = MOTION_FORMAT;
  out.name = motionName(name || s.name);
  const keys = s.keys.filter(k => k && typeof k === 'object' && Number.isFinite(Number(k.t)))
    .map(k => Object.fromEntries(Object.entries(k).filter(([f]) => KEY_FIELDS.has(f))))
    .map(k => ({ ...k, t: Math.max(0, Number(k.t)) }))
    .sort((x, y) => x.t - y.t);
  if (!keys.length) return { error: 'no key has a time' };
  if (keys.length > MAX_KEYS) return { error: `${keys.length} keys, the limit is ${MAX_KEYS}` };
  keys[0].t = 0;
  const last = keys[keys.length - 1].t;
  const duration = Number(out.duration) > 0 ? Number(out.duration) : last || 2;
  if (duration > MAX_SECONDS) return { error: `${duration} s, the limit is ${MAX_SECONDS}` };
  out.duration = Math.max(duration, last);
  out.loop = out.loop === true;
  out.keys = keys;
  for (const k of keys) {
    for (const [side, h] of Object.entries(k.hands || {})) {
      if (!['left', 'right'].includes(side)) return { error: `hands.${side}: only left and right` };
      const lm = h?.at?.landmark;
      if (lm && !LANDMARKS.includes(lm) && !/^(left|right)Thigh@(0(\.\d+)?|1(\.0+)?)$/.test(lm)) return { error: `unknown landmark ${lm}` };
      if (h?.palm && !PALMS.includes(h.palm)) return { error: `palm ${h.palm}` };
      if (h?.shape && !SHAPES.includes(h.shape)) return { error: `shape ${h.shape}` };
      if (h?.elbow && !ELBOWS.includes(h.elbow)) return { error: `elbow ${h.elbow}` };
    }
  }
  if (JSON.stringify(out).length > 64 * 1024) return { error: 'the script is over 64 KB' };
  return { script: out };
}

/** A job's state from GET /api/anim/jobs/<id> (or a cached 200), whatever envelope it comes in. */
export function readJob(d) {
  const j = d?.job && typeof d.job === 'object' ? d.job : d || {};
  const id = typeof d?.job === 'string' ? d.job : j.id || j.job || null;
  const status = String(j.status || (d?.cached ? 'passed' : 'queued'));
  const link = (v) => (typeof v === 'string' ? v : v?.url || null);
  const report = j.report || d?.report || null;
  // A job the solver never finished says why in its report (`{error: "timeout"}`, 2026-11-20).
  return { id, status, report, vrma: link(j.vrma || d?.vrma), preview: link(j.preview || d?.preview), reason: j.reason || j.error || report?.error || report?.reason || null };
}

/**
 * How each check gives its number, from the store's solver (v6, 3910 #1931): the field, its unit, and where its limit
 * lives (most limits are at the report's top level, `limits`; pose_fidelity carries its own limit_deg; arm_tuck's 10 mm
 * is built in). wrist.max_deg is a map { left, right }; seam.value is [pose deg, velocity deg/frame], gated on the first.
 */
const CHECKS = {
  through: { field: 'worst_mm', unit: ' mm', limit: 'through_mm' },
  wrist: { field: 'max_deg', unit: '°', limit: 'wrist_max' },
  arm_tuck: { field: 'elbow_inside_mm', unit: ' mm', fixed: 10 },
  seam: { field: 'value', unit: '°', fixed: 0.5 },
  face_cover: { field: 'max', unit: ' of the face', limit: 'face_cover_max', pct: true },
  prop_target: { field: 'worst_mm', unit: ' mm', limit: 'prop_target_mm' },
  pose_fidelity: { field: 'worst_deg', unit: '°', own: 'limit_deg' }
};

const round = (n) => Math.round(n * 10) / 10;

/** A check's number: a map ({ left, right }) gives its largest and the side; a list gives its first. */
function measureOf(c, spec) {
  const v = c[spec.field];
  if (typeof v === 'number') return { value: v };
  if (Array.isArray(v) && typeof v[0] === 'number') return { value: v[0] };
  if (v && typeof v === 'object') {
    const [side, n] = Object.entries(v).filter(([, x]) => typeof x === 'number').sort((a, b) => b[1] - a[1])[0] || [];
    if (side != null) return { value: n, side };
  }
  return null;
}

/**
 * The checks a report says failed, in a line the owner can read ("through 5.5 mm (limit 3 mm) at 1.9 s, right->arm");
 * '' when none is named. The store's report: { status, checks: { <name>: { pass, ... } }, limits, nudges, rounds }.
 * A check with only { pass, note } has no number; its note is the reason.
 */
export function reportFailures(report, limit = 4) {
  if (!report) return '';
  const named = (o) => Object.entries(o).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => ({ name: k, ...v }));
  const checks = Array.isArray(report) ? report : Array.isArray(report.checks) ? report.checks
    : report.checks && typeof report.checks === 'object' ? named(report.checks) : named(report);
  const limits = report && typeof report.limits === 'object' ? report.limits : {};
  const bad = checks.filter(c => c && (c.pass === false || c.ok === false || c.passed === false || /fail/i.test(String(c.status || c.result || ''))));
  return bad.slice(0, limit).map(c => {
    const key = String(c.name || c.check || c.id || 'check');
    const name = key.replace(/_/g, ' ');
    const spec = CHECKS[key];
    let num = ''; let lim = '';
    if (spec) {
      const m = measureOf(c, spec);
      const l = spec.own ? c[spec.own] : spec.limit ? limits[spec.limit] : spec.fixed;
      const fmt = (n) => (spec.pct ? `${Math.round(n * 100)}%` : `${round(n)}`);
      if (m) num = ` ${fmt(m.value)}${spec.pct ? '' : spec.unit}${m.side ? ` (${m.side})` : ''}`;
      if (typeof l === 'number') lim = ` (limit ${fmt(l)}${spec.pct ? '' : spec.unit})`;
      if (spec.pct && num) num += spec.unit;
    } else {
      // A check this list doesn't know yet: its first measure-looking number, if any.
      const k = Object.keys(c).find(x => /^(worst|peak|max|value)(_[a-z]+)?$/.test(x) && typeof c[x] === 'number');
      const unit = c.unit || (/_mm$/.test(k || '') ? ' mm' : /_deg$/.test(k || '') ? '°' : '');
      if (k) num = ` ${round(c[k])}${unit}`;
      const own = [c.limit, c.limit_mm, c.limit_deg, limits[`${key}_mm`], limits[`${key}_max`]].find(x => typeof x === 'number');
      if (own != null) lim = ` (limit ${round(own)}${unit})`;
    }
    const at = Number.isFinite(c.at_t) ? ` at ${c.at_t} s` : '';
    const where = c.where ? `, ${c.where}` : c.side ? `, ${c.side}` : '';
    const note = !num && c.note ? `: ${c.note}` : c.line ? `: ${c.line}` : '';
    return `${name}${num}${lim}${at}${where}${note}`;
  }).join('; ');
}

/** Words of a request that say what the move is ("wave with both hands" → wave, both, hands), as tags for finding it later. */
export function motionTags(request) {
  const skip = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'or', 'with', 'your', 'you', 'yourself', 'me', 'my', 'make', 'new', 'animation', 'move', 'clip',
    'do', 'please', 'can', 'could', 'for', 'like', 'that', 'this', 'some', 'it', 'on', 'in', 'at', 'is', 'are', 'be', 'create', 'build', 'get']);
  return [...new Set(String(request || '').toLowerCase().match(/[a-z]{3,}/g) || [])].filter(w => !skip.has(w)).slice(0, 8);
}
