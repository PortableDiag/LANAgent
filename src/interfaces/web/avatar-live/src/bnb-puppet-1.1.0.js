// LANAgent: vendored from https://botsandborgs.com/puppet/bnb-puppet-1.1.0.js (MIT), sha256 ee482011d65e1d5f0503a24bb0879f1faf3b4f59791cca55a802cd97f9be30de.
// bnb-puppet.js: the live-puppeting runtime (Bots & Borgs Realtime Animation API step 4, spec §8a/§8d).
// MIT License, (c) Bots & Borgs. https://botsandborgs.com/puppet/
//
// Solves a pose every frame in the VIEWER from small commands (one bnb-motion/1 key, partial), against the avatar's rig
// profile (GET /api/puppet/rig?token= | /api/rig/...): its landmarks (bone + offset in that bone's rest frame) and limits.
// No network in the frame: a command lands as soon as it arrives. Works on any three-vrm 3.x VRM; no bare imports
// (pass your THREE), so it bundles under a strict CSP.
//
//   import { attach, connect } from "./bnb-puppet-1.0.0.js";
//   const p = attach(THREE, vrm, rig, { camera });            // rig = the profile JSON
//   connect(ws, token, p);                                     // the token's `ws` + the token (sent as the first frame)
//   // every frame, AFTER your mixer and BEFORE vrm.update(dt):  p.update(dt)
//
// Per frame: two-bone IK per arm to its target (elbow pole), the hand kept out of the torso capsule, the wrist straight
// along the forearm (well inside wrist_max), fingers to the named shape, head/neck and spine spread with limits,
// expressions + visemes + voice level (the jaw BONE when the rig has one) eased. A bad target is clamped, never thrown.
export const VERSION = "1.1.0";

const PARTS = ["hands", "gaze", "head", "lean", "mouth", "face"];
const KNOWN = new Set(["hands", "point_at", "gaze", "head", "lean", "mood", "expression", "visemes", "level", "pose", "clip",
  "keys", "ease", "duration", "weight", "hold", "release", "end", "vrm_sha256", "t"]);
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"];
const JOINTS = ["Proximal", "Intermediate", "Distal"];
const SHAPES = { // curl per finger (thumb..little), radians per joint
  open: [0, 0, 0, 0, 0], wave: [0, 0, 0, 0, 0], relaxed: [0.15, 0.25, 0.3, 0.35, 0.4],
  fist: [0.6, 1.4, 1.45, 1.5, 1.5], grip: [0.5, 1.1, 1.15, 1.2, 1.2], pump: [0.6, 1.4, 1.45, 1.5, 1.5],
  point: [0.6, 0, 1.45, 1.5, 1.5], thumbs_up: [-0.2, 1.45, 1.5, 1.5, 1.5],
};
const POSES = { // named whole-body gestures (as commands; "wave" also swings)
  wave: { hands: { right: { at: { landmark: "rightShoulder", offset: [-0.22, 0.26, 0.14] }, shape: "wave", palm: "forward", elbow: "down" } } },
  point: { point_at: { landmark: "camera", hand: "right" } },
  thumbs_up: { hands: { right: { at: { landmark: "chest", offset: [-0.12, 0.02, 0.32] }, shape: "thumbs_up", elbow: "down" } } },
  shrug: { hands: { left: { at: { landmark: "leftHip", offset: [0.14, 0.12, 0.22] }, shape: "open" }, right: { at: { landmark: "rightHip", offset: [-0.14, 0.12, 0.22] }, shape: "open" } }, head: { tilt: 8 } },
  // the target is the WRIST: for "think" it sits below the chin so the knuckles, not the palm, reach the jaw (no face cover)
  think: { hands: { right: { at: { landmark: "chin", offset: [-0.01, -0.08, 0.09] }, shape: "fist", palm: "in", elbow: "down" } }, head: { tilt: -6, bow: 5 }, gaze: { yaw: 15, pitch: 10 } },
  cheer: { hands: { left: { at: { landmark: "leftShoulder", offset: [0.15, 0.5, 0.05] }, shape: "fist", elbow: "out" }, right: { at: { landmark: "rightShoulder", offset: [-0.15, 0.5, 0.05] }, shape: "fist", elbow: "out" } }, mood: { happy: 0.8 } },
  bow: { lean: { forward: 22 }, head: { bow: 15 }, hands: { left: { rest: "hang" }, right: { rest: "hang" } } },
};
const UPPER = /spine|chest|neck|head|shoulder|arm|hand|thumb|index|middle|ring|little|jaw|eye/i;

export function attach(THREE, vrm, rig, opts = {}) {
  const V = THREE.Vector3, Q = THREE.Quaternion;
  const H = vrm.humanoid, E = vrm.expressionManager;
  const bone = (n) => (H && H.getNormalizedBoneNode ? H.getNormalizedBoneNode(n) : null);
  const lim = Object.assign({ wrist_max: 40, through_mm: 3, head_turn_max: 70, head_bow_max: 40, lean_max: 25 }, rig.limits || {});
  const D = Math.PI / 180;
  const warned = new Set();
  const warn = (m) => { if (!warned.has(m)) { warned.add(m); (opts.log || console.warn)(`bnb-puppet: ${m}`); } };
  const clampDeg = (x, m) => Math.max(-m, Math.min(m, +x || 0));
  // ---- state: TARGET (what commands asked) and CURRENT (eased) ----
  const tgt = { hands: { left: null, right: null }, gaze: null, head: { turn: 0, bow: 0, tilt: 0 }, lean: { forward: 0, side: 0, twist: 0 },
    mood: {}, expression: {}, visemes: {}, level: 0 };
  const w = {}; const wT = {}; for (const p of PARTS) { w[p] = 0; wT[p] = 0; }   // per-part control weight (0 = the clip/idle)
  let ease = 0.12, master = 1, clock = 0, swing = 0;
  const cur = { head: { turn: 0, bow: 0, tilt: 0 }, lean: { forward: 0, side: 0, twist: 0 }, expr: {}, level: 0, curl: { left: SHAPES.relaxed.slice(), right: SHAPES.relaxed.slice() } };
  const handPos = { left: null, right: null };
  const timers = []; // [{at, cmd}]
  let releaseAt = null, releaseParts = null;
  // ---- the rig ----
  const L = rig.landmarks || {};
  // A rig whose fingers REST curled (Sentry: 39 deg) reads every shape as a claw: straighten each finger's rest chain
  // along the hand's axis first, then apply the shape on top (local = shape * fix), as the solver does (anim_solve v9).
  const REST_FIX_DEG = 15;
  const restFix = {};
  {
    const P = (n) => {
      const r = rig.bones && rig.bones[n];
      if (r) return new V(r[0], r[1], r[2]);
      const b = bone(n); if (!b) return null; b.updateWorldMatrix(true, false);
      return vrm.scene.worldToLocal(b.getWorldPosition(new V()));
    };
    for (const sd of ["left", "right"]) {
      const h = P(`${sd}Hand`), m = P(`${sd}MiddleProximal`);
      if (!h || !m) continue;
      const t = m.clone().sub(h).normalize();
      for (const f of ["Index", "Middle", "Ring", "Little"]) {
        const pp = P(`${sd}${f}Proximal`), pi = P(`${sd}${f}Intermediate`), pd = P(`${sd}${f}Distal`);
        if (!pp || !pi || !pd) continue;
        const curl = Math.acos(Math.max(-1, Math.min(1, pd.clone().sub(pp).normalize().dot(t)))) / D;
        if (curl <= REST_FIX_DEG) continue;
        const qp = new Q().setFromUnitVectors(pi.clone().sub(pp).normalize(), t);
        const tInP = t.clone().applyQuaternion(qp.clone().invert());
        restFix[`${sd}${f}Proximal`] = qp;
        restFix[`${sd}${f}Intermediate`] = new Q().setFromUnitVectors(pd.clone().sub(pi).normalize(), tInP);
      }
    }
  }
  const landmark = (name) => {
    if (name === "camera") return opts.camera ? opts.camera.getWorldPosition(new V()) : null;
    const l = L[name];
    if (l) { const b = bone(l[0]); if (b) { b.updateWorldMatrix(true, false); return b.localToWorld(new V(l[1][0], l[1][1], l[1][2])); } }
    const b = bone(name); // any humanoid joint is a landmark too
    if (b) { b.updateWorldMatrix(true, false); return b.getWorldPosition(new V()); }
    warn(`unknown landmark ${name}`);
    return null;
  };
  const rootQ = () => { const r = vrm.scene; r.updateWorldMatrix(true, false); return r.getWorldQuaternion(new Q()); };
  const bodyVec = (a) => new V(a[0], a[1], a[2]).applyQuaternion(rootQ());   // body space -> world
  const scale = () => { const s = new V(); vrm.scene.getWorldScale(s); return s.y || 1; };
  // where a hand target lands in the world (null = no target)
  function handTarget(side, h) {
    if (!h) return null;
    const sgn = side === "left" ? 1 : -1;
    if (h.rest) {
      const sh = bone(`${side}UpperArm`); if (!sh) return null;
      const s = sh.getWorldPosition(new V()), r = armLen(side);   // world units
      const f = h.rest === "hip" ? [0.25, -0.6, 0.1] : h.rest === "behind" ? [0.15, -0.65, -0.25] : [0.1, -0.97, 0.04];   // of the arm length
      return s.add(bodyVec([sgn * f[0] * r, f[1] * r, f[2] * r]));
    }
    if (h.at) {
      const base = h.at.landmark ? landmark(h.at.landmark) : h.at.world ? new V(...h.at.world) : null;
      if (!base) return null;
      const o = h.at.offset || [0, 0, 0];
      return base.add(bodyVec(o).multiplyScalar(scale()));
    }
    return null;
  }
  const armLen = (side) => {
    const a = bone(`${side}UpperArm`), b = bone(`${side}LowerArm`), c = bone(`${side}Hand`);
    if (!a || !b || !c) return 0.5;
    return a.getWorldPosition(new V()).distanceTo(b.getWorldPosition(new V())) + b.getWorldPosition(new V()).distanceTo(c.getWorldPosition(new V()));
  };
  // the torso capsule (hips -> neck), radius from the belly/chest landmarks: a hand target inside is pushed out
  function pushOutHead(p) {
    const chin = L.chin && landmark("chin"), crown = L.crown && landmark("crown");
    const hd = bone("head"); if (!hd) return p;
    let c, r;
    if (chin && crown) { c = chin.clone().add(crown).multiplyScalar(0.5); r = chin.distanceTo(crown) / 2; }
    else { c = hd.getWorldPosition(new V()).add(bodyVec([0, 0.1 * scale(), 0])); r = 0.12 * scale(); }
    const nose = L.nose && landmark("nose");
    if (nose) r = Math.max(r, nose.distanceTo(c));
    const m = r + (lim.through_mm / 1000 + 0.02) * scale();   // + 2 cm: the hand itself has a thickness
    const d = p.clone().sub(c);
    if (d.length() >= m) return p;
    if (d.lengthSq() < 1e-8) d.copy(bodyVec([0, 0, 1]));
    return c.add(d.normalize().multiplyScalar(m));
  }
  function pushOut(p) {
    p = pushOutHead(p);
    const hips = bone("hips"), neck = bone("neck") || bone("upperChest") || bone("chest");
    if (!hips || !neck) return p;
    const a = hips.getWorldPosition(new V()), b = neck.getWorldPosition(new V());
    let r = 0.12 * scale();
    const lb = L.leftBelly && landmark("leftBelly"), rb = L.rightBelly && landmark("rightBelly");
    if (lb && rb) r = Math.max(r, lb.distanceTo(rb) / 2 + 0.03 * scale());
    const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()));
    const c = a.clone().add(ab.multiplyScalar(t)), d = p.clone().sub(c), m = r + lim.through_mm / 1000 * scale();
    if (d.length() >= m) return p;
    if (d.lengthSq() < 1e-8) d.copy(bodyVec([0, 0, 1]));
    return c.add(d.normalize().multiplyScalar(m));
  }
  // rotate `b` (world) so its child direction points along `dir`, blended by `k` from its current pose
  function aim(b, child, dir, k) {
    b.updateWorldMatrix(true, false); child.updateWorldMatrix(true, false);
    const bp = b.getWorldPosition(new V()), cp = child.getWorldPosition(new V());
    const now = cp.sub(bp).normalize();
    if (now.lengthSq() < 1e-9 || dir.lengthSq() < 1e-9) return;
    const delta = new Q().setFromUnitVectors(now, dir.clone().normalize());
    const wq = b.getWorldQuaternion(new Q());
    const want = delta.multiply(wq);
    const pq = b.parent.getWorldQuaternion(new Q()).invert();
    const local = pq.multiply(want);
    b.quaternion.slerp(local, k);
    b.updateWorldMatrix(false, true);
  }
  function solveArm(side, target, elbow, k) {
    const ua = bone(`${side}UpperArm`), la = bone(`${side}LowerArm`), hd = bone(`${side}Hand`);
    if (!ua || !la || !hd || !target || k <= 0) return;
    const sgn = side === "left" ? 1 : -1;
    ua.updateWorldMatrix(true, true);
    const S = ua.getWorldPosition(new V()), Eb = la.getWorldPosition(new V()), W = hd.getWorldPosition(new V());
    const l1 = S.distanceTo(Eb), l2 = Eb.distanceTo(W);
    let T = pushOut(target.clone());
    let st = T.clone().sub(S); let d = st.length();
    const dmax = (l1 + l2) * 0.999, dmin = Math.abs(l1 - l2) + 1e-4;
    if (d > dmax) { st.multiplyScalar(dmax / d); d = dmax; T = S.clone().add(st); }
    if (d < dmin) { st.setLength(dmin); d = dmin; T = S.clone().add(st); }
    const pole = Array.isArray(elbow) ? bodyVec(elbow) : bodyVec(elbow === "out" ? [sgn, -0.3, -0.1] : elbow === "back" ? [sgn * 0.3, -0.4, -1] : [sgn * 0.25, -1, -0.15]);
    const u = st.clone().normalize();
    const pp = pole.sub(u.clone().multiplyScalar(pole.dot(u)));
    if (pp.lengthSq() < 1e-8) pp.copy(bodyVec([0, -1, 0]));
    pp.normalize();
    const a = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
    const elbowP = S.clone().add(u.clone().multiplyScalar(Math.cos(a) * l1)).add(pp.multiplyScalar(Math.sin(a) * l1));
    aim(ua, la, elbowP.clone().sub(S), k);
    aim(la, hd, T.clone().sub(la.getWorldPosition(new V())), k);
    hd.quaternion.slerp(new Q(), k); // the wrist straight along the forearm: 0 deg bend (inside wrist_max)
    handPos[side] = T;
  }
  // the palm faces a BODY-space direction (as the solver's palm): the hand turns about its own finger axis (the straight
  // forearm) until its palm normal is as close to it as that axis allows. A roll by name was forearm-relative ("in" and
  // "forward" were the same 90 deg), so "forward" was only right when the forearm pointed the way the wave's does.
  const PALM = { down: [0, -1, 0], up: [0, 1, 0], in: [-1, 0, 0], out: [1, 0, 0], forward: [0, 0, 1], back: [0, 0, -1] };
  function palm(side, h, k) {
    const hd = bone(`${side}Hand`); if (!hd || !h || !h.palm || !PALM[h.palm]) return;
    const sgn = side === "left" ? 1 : -1;
    hd.updateWorldMatrix(true, false);
    const wq = hd.getWorldQuaternion(new Q());
    const axis = new V(sgn, 0, 0).applyQuaternion(wq).normalize();         // normalized rig: fingers along +x (left) / -x (right)
    const pn = new V(0, -1, 0).applyQuaternion(wq);                         // ... palm down at rest
    const pw = PALM[h.palm];
    const w = bodyVec([h.palm === "in" || h.palm === "out" ? sgn * pw[0] : pw[0], pw[1], pw[2]]);
    w.sub(axis.clone().multiplyScalar(w.dot(axis)));
    const p = pn.sub(axis.clone().multiplyScalar(pn.dot(axis)));
    if (w.lengthSq() < 1e-6 || p.lengthSq() < 1e-6) return;               // asked along the forearm itself: keep the roll
    w.normalize(); p.normalize();
    const ang = Math.atan2(axis.dot(new V().crossVectors(p, w)), p.dot(w));
    const wantW = new Q().setFromAxisAngle(axis, ang).multiply(wq);
    const local = hd.parent.getWorldQuaternion(new Q()).invert().multiply(wantW);
    hd.quaternion.slerp(local, k);
    hd.updateWorldMatrix(false, true);
  }
  function fingers(side, k, dt) {
    const h = tgt.hands[side];
    const want = SHAPES[(h && h.shape) || "relaxed"] || SHAPES.relaxed;
    const c = cur.curl[side], a = Math.min(1, dt / Math.max(ease, 1e-3));
    for (let i = 0; i < 5; i++) {
      c[i] += (want[i] - c[i]) * a;
      for (const j of JOINTS) {
        const b = bone(`${side}${FINGERS[i]}${j}`); if (!b) continue;
        // normalized rig: fingers along +x (left) / -x (right), the palm down: a curl turns the tips to -y
        const axis = i === 0 ? new V(0, 1, 0) : new V(0, 0, 1);
        const ang = (side === "left" ? -1 : 1) * c[i] * (i === 0 ? 0.6 : 1);
        const want = new Q().setFromAxisAngle(axis, ang);
        const fx = restFix[`${side}${FINGERS[i]}${j}`];
        if (fx) want.multiply(fx);
        b.quaternion.slerp(want, k);
      }
    }
  }
  function spread(names, fr, e, k) { // e: Euler degrees [x, y, z] spread over the bones by fraction
    names.forEach((n, i) => {
      const b = bone(n); if (!b) return;
      const q = new Q().setFromEuler(new THREE.Euler(e[0] * fr[i] * D, e[1] * fr[i] * D, e[2] * fr[i] * D));
      b.quaternion.slerp(b.quaternion.clone().multiply(q), k);
    });
  }
  let clipAction = null;
  async function playClip(c) {
    if (!opts.mixer || !opts.clipFor) { warn("clip: pass {mixer, clipFor(id)} to attach() to play library clips"); return; }
    if (c.stop) { if (clipAction) clipAction.fadeOut(ease); clipAction = null; return; }
    let clip = await opts.clipFor(c.id);
    if (!clip) { warn(`clip ${c.id}: not found`); return; }
    if (c.mask === "upper") clip = new THREE.AnimationClip(clip.name + "-upper", clip.duration, clip.tracks.filter((t) => UPPER.test(t.name)));
    const act = opts.mixer.clipAction(clip);
    act.setLoop(c.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    act.clampWhenFinished = true;
    act.setEffectiveWeight(c.weight === undefined ? 1 : c.weight);
    if (clipAction && clipAction !== act) clipAction.fadeOut(ease);
    act.reset().fadeIn(ease).play();
    clipAction = act;
  }
  function release(parts) {
    for (const p of parts === true || !parts ? PARTS : parts) if (p in wT) wT[p] = 0;
  }
  // ---- commands ----
  function apply(cmd, fromTimeline = false) {
    if (!cmd || typeof cmd !== "object") return;
    if (cmd.vrm_sha256 && rig.vrm_sha256 && cmd.vrm_sha256 !== rig.vrm_sha256) { warn("a command for another model file was ignored"); return; }
    for (const k of Object.keys(cmd)) if (!KNOWN.has(k)) warn(`unknown field ${k} ignored`);
    if (Array.isArray(cmd.keys) && !fromTimeline) {
      const ks = cmd.keys.slice(0, 8).sort((a, b) => (a.t || 0) - (b.t || 0));
      ks.forEach((k, i) => { const next = ks[i + 1]; timers.push({ at: clock + (+k.t || 0), cmd: Object.assign({ ease: next ? Math.max(0.05, next.t - k.t) : cmd.ease }, k) }); });
    }
    if (cmd.end) { release(true); playClip({ stop: true }); return; }
    if (cmd.pose) { const p = POSES[cmd.pose]; if (p) apply(Object.assign({}, p, { ease: cmd.ease }), true); else warn(`unknown pose ${cmd.pose}`); swing = cmd.pose === "wave" ? clock : 0; }
    if (cmd.ease !== undefined) ease = Math.max(0, +cmd.ease || 0);
    if (cmd.weight !== undefined) master = Math.max(0, Math.min(1, +cmd.weight));
    if (cmd.hands) {
      for (const s of ["left", "right"]) if (cmd.hands[s] !== undefined) tgt.hands[s] = cmd.hands[s];
      wT.hands = 1;
    }
    if (cmd.point_at) {
      const s = cmd.point_at.hand === "left" ? "left" : "right";
      tgt.hands[s] = { point_at: cmd.point_at, shape: "point", elbow: "down" };
      wT.hands = 1;
    }
    if (cmd.gaze) { tgt.gaze = cmd.gaze; wT.gaze = 1; }
    if (cmd.head) { Object.assign(tgt.head, cmd.head); wT.head = 1; }
    if (cmd.lean) { Object.assign(tgt.lean, cmd.lean); wT.lean = 1; }
    if (cmd.mood) { tgt.mood = Object.assign({}, cmd.mood); wT.face = 1; }
    if (cmd.expression) { Object.assign(tgt.expression, cmd.expression); wT.face = 1; }
    if (!opts.localVoice) {
      if (cmd.visemes) { tgt.visemes = Object.assign({}, cmd.visemes); wT.mouth = 1; }
      if (cmd.level !== undefined) { tgt.level = Math.max(0, Math.min(1, +cmd.level || 0)); wT.mouth = 1; }
    }
    if (cmd.clip) playClip(cmd.clip);
    if (cmd.release) release(cmd.release);
    if (cmd.duration && !cmd.hold) { releaseAt = clock + +cmd.duration; releaseParts = PARTS.filter((p) => wT[p] > 0); }
    if (cmd.hold) releaseAt = null;
  }
  // ---- the frame ----
  // Every frame starts from the pose underneath: what the clip/idle wrote this frame, or, for a bone nobody else wrote,
  // the base it had before our last frame (so our offsets never stack up frame after frame).
  const TOUCH = ["spine", "chest", "upperChest", "neck", "head", "jaw"];
  for (const s of ["left", "right"]) { TOUCH.push(`${s}UpperArm`, `${s}LowerArm`, `${s}Hand`); for (const f of FINGERS) for (const j of JOINTS) TOUCH.push(`${s}${f}${j}`); }
  const lastOut = new Map(), lastBase = new Map();
  function update(dt) {
    dt = Math.max(0, Math.min(0.1, +dt || 0));
    clock += dt;
    for (const n of TOUCH) {
      const b = bone(n); if (!b) continue;
      const o = lastOut.get(n);
      if (o && b.quaternion.equals(o)) b.quaternion.copy(lastBase.get(n));
      lastBase.set(n, b.quaternion.clone());
    }
    vrm.scene.updateMatrixWorld(true);
    frame(dt);
    for (const n of TOUCH) { const b = bone(n); if (b) lastOut.set(n, b.quaternion.clone()); }
  }
  function frame(dt) {
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].at <= clock) { const t = timers.splice(i, 1)[0]; apply(t.cmd, true); }
    if (releaseAt !== null && clock >= releaseAt) { release(releaseParts); releaseAt = null; }
    const a = ease > 0 ? Math.min(1, dt / ease) : 1;
    for (const p of PARTS) w[p] += (wT[p] - w[p]) * a;
    // lean, then head (the arms solve against the leaned body)
    for (const k of ["forward", "side", "twist"]) cur.lean[k] += (clampDeg(tgt.lean[k], lim.lean_max) - cur.lean[k]) * a;
    if (w.lean > 0.001) spread(["spine", "chest", "upperChest"], [0.4, 0.35, 0.25], [cur.lean.forward, cur.lean.twist, -cur.lean.side], w.lean * master);
    cur.head.turn += (clampDeg(tgt.head.turn, lim.head_turn_max) - cur.head.turn) * a;
    cur.head.bow += (clampDeg(tgt.head.bow, lim.head_bow_max) - cur.head.bow) * a;
    cur.head.tilt += (clampDeg(tgt.head.tilt, 30) - cur.head.tilt) * a;
    if (w.head > 0.001) spread(["neck", "head"], [0.4, 0.6], [cur.head.bow, cur.head.turn, -cur.head.tilt], w.head * master);
    // arms
    for (const s of ["left", "right"]) {
      const h = tgt.hands[s];
      const k = w.hands * master;
      if (!h || k <= 0.001) continue;
      let T;
      if (h.point_at) {
        const to = h.point_at.world ? new V(...h.point_at.world) : landmark(h.point_at.landmark || "camera");
        const sh = bone(`${s}UpperArm`);
        if (to && sh) { const S = sh.getWorldPosition(new V()); T = S.clone().add(to.sub(S).setLength(armLen(s) * 0.92)); }
      } else T = handTarget(s, h);
      if (T && h.shape === "wave" && swing) T.add(bodyVec([Math.sin((clock - swing) * 9) * 0.06 * scale(), 0, 0]));
      const want = T ? (handPos[s] ? handPos[s].clone().lerp(T, a) : T) : null;
      solveArm(s, want, h.elbow, k);
      palm(s, h, k);
      fingers(s, k, dt);
    }
    // gaze: the eyes (three-vrm lookAt), a little of it in the head
    if (w.gaze > 0.01 && tgt.gaze && vrm.lookAt) {
      const g = tgt.gaze;
      let p = g.world ? new V(...g.world) : g.landmark ? landmark(g.landmark) : g.camera ? landmark("camera") : null;
      if (!p && (g.yaw !== undefined || g.pitch !== undefined)) {
        const hd = bone("head"); const o = hd ? hd.getWorldPosition(new V()) : new V();
        p = o.add(bodyVec([Math.sin((+g.yaw || 0) * D), Math.sin((+g.pitch || 0) * D), Math.cos((+g.yaw || 0) * D)]).multiplyScalar(2));
      }
      if (p) { if (!vrm.lookAt.target || !vrm.lookAt.target.isPuppetGaze) { const o = new THREE.Object3D(); o.isPuppetGaze = true; vrm.lookAt.target = o; } vrm.lookAt.target.position.copy(p); vrm.lookAt.autoUpdate = true; }
    } else if (vrm.lookAt && vrm.lookAt.target && vrm.lookAt.target.isPuppetGaze && w.gaze <= 0.01) vrm.lookAt.target = null;
    // face: mood (base) + expression (on top) + mouth
    if (E) {
      const want = {};
      if (w.face > 0.001) {
        for (const [k, v] of Object.entries(tgt.mood)) want[k] = Math.max(want[k] || 0, v * w.face);
        for (const [k, v] of Object.entries(tgt.expression)) want[k] = Math.max(want[k] || 0, v * w.face);
      }
      cur.level += ((w.mouth > 0.001 ? tgt.level : 0) - cur.level) * Math.min(1, dt / 0.05);
      const jaw = rig.jaw_baked ? null : bone("jaw");   // a jaw-baked model opens with its visemes: never also turn the bone
      if (w.mouth > 0.001) {
        for (const [k, v] of Object.entries(tgt.visemes)) want[k] = Math.max(want[k] || 0, v * w.mouth);
        if (cur.level > 0.001) want.aa = Math.max(want.aa || 0, cur.level * (jaw ? 0.5 : 0.9) * w.mouth);
      }
      if (jaw) jaw.quaternion.slerp(new Q().setFromAxisAngle(new V(1, 0, 0), cur.level * 18 * D), w.mouth);
      for (const k of new Set([...Object.keys(want), ...Object.keys(cur.expr)])) {
        const v = cur.expr[k] || 0, t = want[k] || 0, n = v + (t - v) * a;
        cur.expr[k] = n;
        if (E.getExpression && E.getExpression(k)) E.setValue(k, n);
        else if (t > 0) warn(`this model has no expression ${k}`);
      }
    }
  }
  return { VERSION, apply, update, release, get weights() { return Object.assign({}, w); }, get rig() { return rig; } };
}

// Connect a puppet to a viewer socket (the `ws` of POST /api/puppet/tokens). Reconnects with back-off; refuses a stream
// for another model file. Returns {close()}.
// The token is sent as the FIRST FRAME, never in the URL (so it never reaches a log).
export function connect(url, token, puppet, { onHello, onEnd, log = console.warn, WebSocketImpl } = {}) {
  const WS = WebSocketImpl || globalThis.WebSocket;
  let ws = null, stop = false, wait = 500;
  const open = () => {
    if (stop) return;
    ws = new WS(url);
    ws.onopen = () => ws.send(JSON.stringify({ view: token }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.hello) {
        wait = 500;
        if (puppet.rig.vrm_sha256 && m.hello.vrm_sha256 !== puppet.rig.vrm_sha256) { log("bnb-puppet: this stream is for another model file"); stop = true; ws.close(); return; }
        if (onHello) onHello(m.hello);
        return;
      }
      if (m.error) { log(`bnb-puppet: ${m.error}: ${m.line || ""}`); if (m.error === "unauthorized") stop = true; return; }
      // revoked / token_expired / access_ended / model_changed: this token is done (a new file needs a new token)
      if (m.end === true && m.reason) { puppet.apply({ end: true }); if (onEnd) onEnd(m.reason); stop = true; return; }
      puppet.apply(m);
    };
    ws.onclose = () => { if (!stop) { setTimeout(open, wait); wait = Math.min(wait * 2, 15000); } };
  };
  open();
  return { close() { stop = true; if (ws) ws.close(); } };
}
