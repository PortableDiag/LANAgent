// How the avatar moves. Each frame: rest pose, then a clip if one is playing, then the living layers
// (breath, sway, speech, a held thought, a gesture, looking at you). Everything works on bones
// through three-vrm's normalized rig, and a bone the model lacks is simply skipped.
import * as THREE from 'three';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Props } from './props.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const q = new THREE.Quaternion();
const e = new THREE.Euler();
const toQ = ([x, y, z]) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const wob = (t, f, a) => Math.sin(t * f) * a;

// Plays a clip by sampling every track and writing every bone, every frame. three's AnimationMixer
// writes a bone only when its value changed since the frame before, and this page puts the body back
// to rest each frame before the clip goes on: a bone the clip held still for a frame (or all along,
// as fingers and twist bones often are) was left at rest. That flipped a facing-away dance to the
// front for single frames and bent held bones out of the clip's shape.
function sampler(clip, root) {
  const parts = clip.tracks.map((t) => {
    const dot = t.name.lastIndexOf('.');
    const node = THREE.PropertyBinding.findNode(root, t.name.slice(0, dot));
    const prop = t.name.slice(dot + 1);
    return node && ['quaternion', 'position', 'scale'].includes(prop) ? { node, prop, interp: t.createInterpolant() } : null;
  }).filter(Boolean);
  return (time) => { for (const p of parts) p.node[p.prop].fromArray(p.interp.evaluate(time)); };
}

// A relaxed hang, not a T: arms close in and slightly forward, elbows and fingers a little bent.
const REST = {
  leftShoulder: [0, 0, -0.06], rightShoulder: [0, 0, 0.06],
  leftUpperArm: [0.05, -0.12, -1.32], rightUpperArm: [0.05, 0.12, 1.32],
  leftLowerArm: [0, -0.42, 0], rightLowerArm: [0, 0.42, 0],
  leftHand: [0.06, 0, -0.1], rightHand: [0.06, 0, 0.1],
};
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];
for (const side of ['left', 'right']) {
  const curl = side === 'left' ? -1 : 1;
  FINGERS.forEach((f, i) => {
    const k = 0.22 + i * 0.05;
    REST[`${side}${f}Proximal`] = [0, 0, curl * k];
    REST[`${side}${f}Intermediate`] = [0, 0, curl * (k + 0.12)];
    REST[`${side}${f}Distal`] = [0, 0, curl * (k * 0.8)];
  });
  REST[`${side}ThumbProximal`] = [0, curl * 0.2, 0];
}
// Small things a person does while standing: one every several seconds, never the same twice running.
const FIDGETS = {
  glance: { seconds: 2.4, pose: (r) => ({ head: [0.02, Math.sin(r * Math.PI) * 0.34, 0], neck: [0, Math.sin(r * Math.PI) * 0.08, 0] }) },
  tilt: { seconds: 2.8, pose: (r) => ({ head: [0, 0, Math.sin(r * Math.PI) * 0.1] }) },
  breath: { seconds: 2.6, pose: (r) => ({ chest: [-Math.sin(r * Math.PI) * 0.05, 0, 0], leftShoulder: [0, 0, Math.sin(r * Math.PI) * 0.05], rightShoulder: [0, 0, -Math.sin(r * Math.PI) * 0.05] }) },
  look_down: { seconds: 2.2, pose: (r) => ({ head: [Math.sin(r * Math.PI) * 0.16, 0, 0] }) },
};

// Moves made in code: the head only. Anything with arms or the body is a real clip (a store or owner
// animation) played as it was made; hand-posing a rigged model's arms looked like a puppet.
export const GESTURES = {
  nod: { seconds: 1.5, pose: (r, s) => ({ head: [0.13 + wob(s, 9, 0.14), 0, 0], neck: [0.05, 0, 0] }) },
  shake_head: { seconds: 1.6, pose: (r, s) => ({ head: [0, wob(s, 9, 0.28), 0] }) },
  look_around: { seconds: 3.4, pose: (r, s) => ({ head: [wob(s, 1.1, 0.06), wob(s, 1.85, 0.5), 0], neck: [0, wob(s, 1.85, 0.12), 0] }) },
};

export const THINK = { head: [0.08, -0.08, 0.08] };  // waiting on a thought: the head tilts

// A clip is fetched once and sniffed: an FBX is fitted to the avatar when it plays, a VRMA carries its
// own humanoid data. Mixamo's bones have a prefix (mixamorig, mixamorig1, ...), so match on the rest.
const clipCache = new Map();
export async function loadClip(name) {
  if (!clipCache.has(name)) {
    clipCache.set(name, fetch(`/api/animations/${encodeURIComponent(name)}/file`).then(async (r) => {
      if (!r.ok) throw new Error(`the server answered ${r.status}`);
      const buf = await r.arrayBuffer();
      if (new TextDecoder().decode(buf.slice(0, 4)) === 'glTF') {
        const loader = new GLTFLoader();
        loader.register((p) => new VRMAnimationLoaderPlugin(p));
        const g = await loader.parseAsync(buf, '');
        return { vrma: g.userData.vrmAnimations?.[0] };
      }
      // Only the motion is wanted: an FBX's textures point at paths on someone else's computer.
      const manager = new THREE.LoadingManager();
      manager.setURLModifier(() => 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==');
      return { fbx: new FBXLoader(manager).parse(buf, '') };
    }).catch((err) => { clipCache.delete(name); throw err; }));
  }
  return clipCache.get(name);
}

export function forgetClip(name) { clipCache.delete(name); }

const FBX_BONES = {
  Hips: 'hips', Spine: 'spine', Spine1: 'chest', Spine2: 'upperChest', Neck: 'neck', Head: 'head',
  LeftShoulder: 'leftShoulder', LeftArm: 'leftUpperArm', LeftForeArm: 'leftLowerArm', LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder', RightArm: 'rightUpperArm', RightForeArm: 'rightLowerArm', RightHand: 'rightHand',
  LeftUpLeg: 'leftUpperLeg', LeftLeg: 'leftLowerLeg', LeftFoot: 'leftFoot', LeftToeBase: 'leftToes',
  RightUpLeg: 'rightUpperLeg', RightLeg: 'rightLowerLeg', RightFoot: 'rightFoot', RightToeBase: 'rightToes',
};
for (const side of ['Left', 'Right']) {
  const s = side.toLowerCase();
  for (const f of ['Index', 'Middle', 'Ring', 'Pinky', 'Thumb']) {
    const to = f === 'Pinky' ? 'Little' : f;
    const [a, b, c] = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    FBX_BONES[`${side}Hand${f}1`] = `${s}${to}${a}`;
    FBX_BONES[`${side}Hand${f}2`] = `${s}${to}${b}`;
    FBX_BONES[`${side}Hand${f}3`] = `${s}${to}${c}`;
  }
}
const fbxKey = (n) => n.replace(/^.*?(?:mixamorig\d*[:_]?|:)/i, '');

// An FBX's motion, retargeted to this avatar's normalized bones.
function fitFbx(asset, vrm) {
  const clips = asset.animations || [];
  const source = clips.find((c) => c.name === 'mixamo.com') || clips.reduce((a, c) => (!a || c.tracks.length > a.tracks.length ? c : a), null);
  if (!source) throw new Error('this FBX has no animation in it');
  const byKey = new Map();
  asset.traverse((o) => { if (o.name) byKey.set(fbxKey(o.name), o); });
  const v = new THREE.Vector3();
  const vrmHips = vrm.humanoid?.getNormalizedBoneNode('hips');
  if (!vrmHips) throw new Error('this avatar has no humanoid body to move');
  const vrmHeight = Math.abs(vrmHips.getWorldPosition(v).y - vrm.scene.getWorldPosition(new THREE.Vector3()).y);
  // How big the source skeleton is, from the length of its leg. An FBX's rest pose can't be trusted for
  // this: one had its hips at 3.5 at rest and 43 in the motion, which threw the avatar 11 m up.
  const legLength = ['LeftUpLeg', 'LeftLeg', 'LeftFoot'].reduce((sum, k) => sum + (byKey.get(k)?.position.length() || 0), 0);
  const hipsTrack = source.tracks.find((t) => fbxKey(t.name.split('.')[0]) === 'Hips' && t.name.endsWith('.position'));
  const trackY = hipsTrack ? [...hipsTrack.values].filter((_, i) => i % 3 === 1).sort((a, b) => a - b) : [];
  const scale = vrmHeight / Math.max(1e-6, legLength > 1e-6 ? legLength : (trackY[trackY.length >> 1] || 1));
  const firstX = hipsTrack ? hipsTrack.values[0] : 0;
  const firstZ = hipsTrack ? hipsTrack.values[2] : 0;
  const old = vrm.meta?.metaVersion === '0';
  const restInv = new THREE.Quaternion(), parentRest = new THREE.Quaternion(), qa = new THREE.Quaternion();
  const tracks = [];
  for (const track of source.tracks) {
    const [rig, prop] = track.name.split('.');
    const key = fbxKey(rig);
    const bone = FBX_BONES[key];
    const node = bone && vrm.humanoid.getNormalizedBoneNode(bone);
    const src = byKey.get(key);
    if (!node || !src?.parent) continue;
    if (track instanceof THREE.QuaternionKeyframeTrack) {
      src.getWorldQuaternion(restInv).invert();
      src.parent.getWorldQuaternion(parentRest);
      const vals = track.values.slice();
      for (let i = 0; i < vals.length; i += 4) {
        qa.fromArray(vals, i).premultiply(parentRest).multiply(restInv);
        qa.toArray(vals, i);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.${prop}`, track.times, vals.map((x, i) => (old && i % 2 === 0 ? -x : x))));
    } else if (track instanceof THREE.VectorKeyframeTrack && bone === 'hips' && prop === 'position') {
      tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.${prop}`, track.times, track.values.map((x, i) => {
        // Height as it is, but sideways relative to where it starts: the dance stays in frame.
        const here = i % 3 === 0 ? x - firstX : i % 3 === 2 ? x - firstZ : x;
        return (old && i % 3 !== 1 ? -here : here) * scale;
      })));
    }
  }
  if (tracks.length < 5) throw new Error(`this FBX's skeleton is not one I know (bones like ${[...byKey.keys()].slice(0, 4).join(', ')}): Mixamo's works`);
  return new THREE.AnimationClip(source.name, source.duration, tracks);
}

// Two-bone arm solve in world space, from the T-pose measured at load: where each joint is, how long
// each segment is, and which way each one points at rest.
class ArmIK {
  constructor(vrm, halfWidth) {
    this.hum = vrm.humanoid;
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    this.height = Math.max(0.3, box.max.y - box.min.y);
    this.halfWidth = halfWidth;
    this.sides = {};
    for (const side of ['left', 'right']) {
      const up = this.node(`${side}UpperArm`), lo = this.node(`${side}LowerArm`), ha = this.node(`${side}Hand`);
      if (!up || !lo || !ha) continue;
      const a = up.getWorldPosition(new THREE.Vector3()), b = lo.getWorldPosition(new THREE.Vector3()), c = ha.getWorldPosition(new THREE.Vector3());
      this.sides[side] = {
        up, lo, ha, l1: a.distanceTo(b), l2: b.distanceTo(c),
        upDir: b.clone().sub(a).normalize(), loDir: c.clone().sub(b).normalize(),
        upRest: up.getWorldQuaternion(new THREE.Quaternion()), loRest: lo.getWorldQuaternion(new THREE.Quaternion()),
        haRest: ha.getWorldQuaternion(new THREE.Quaternion()), haDir: c.clone().sub(b).normalize(),
        // The elbow's axis at rest: turning the forearm about it swings the hand forward (+z).
        hinge: new THREE.Vector3().crossVectors(b.clone().sub(a).normalize(), new THREE.Vector3(0, 0, 1)).normalize(),
      };
    }
    this.hipsNode = this.node('hips');
  }

  node(b) { return this.hum?.getNormalizedBoneNode(b) || null; }

  // Where a named place on the body is right now, plus an offset in heights of the avatar.
  target(at, off) {
    const h = this.height;
    let base;
    if (at === 'hipLeft' || at === 'hipRight') {
      base = this.hipsNode.getWorldPosition(new THREE.Vector3());
      base.x += (at === 'hipLeft' ? 1 : -1) * this.halfWidth;
    } else {
      const n = this.node(at) || this.node('chest') || this.node('spine') || this.hipsNode;
      base = n.getWorldPosition(new THREE.Vector3());
    }
    return base.add(new THREE.Vector3(off[0] * h, off[1] * h, off[2] * h));
  }

  // Bends the arm toward the target by weight w, and returns where the hand was asked to go.
  solve(side, spec, w) {
    const a = this.sides[side];
    if (!a) return null;
    const T = this.target(spec.at, spec.off);
    a.up.parent.updateWorldMatrix(true, false);
    const S = a.up.getWorldPosition(new THREE.Vector3());
    const d = T.clone().sub(S);
    const dist = THREE.MathUtils.clamp(d.length(), Math.abs(a.l1 - a.l2) + 1e-3, a.l1 + a.l2 - 1e-3);
    const n = d.normalize();
    const along = (a.l1 * a.l1 - a.l2 * a.l2 + dist * dist) / (2 * dist);
    const out = Math.sqrt(Math.max(0, a.l1 * a.l1 - along * along));
    const hint = new THREE.Vector3(...spec.elbow);
    hint.addScaledVector(n, -hint.dot(n));
    if (hint.lengthSq() < 1e-6) hint.set(0, -1, 0).addScaledVector(n, n.y);
    hint.normalize();
    const E = S.clone().addScaledVector(n, along).addScaledVector(hint, out);
    const H = S.clone().addScaledVector(n, dist);
    // An elbow is a hinge: it bends the forearm forward and nothing else. The shortest turn to each
    // direction bent it sideways too (a second elbow in the forearm), so the upper arm rolls about
    // itself until its hinge lies across the plane of the arm, and the forearm turns about that hinge.
    const u = E.clone().sub(S).normalize(), f = H.clone().sub(E).normalize();
    const turn = new THREE.Quaternion().setFromUnitVectors(a.upDir, u);
    const hinge = a.hinge.clone().applyQuaternion(turn);
    const want = new THREE.Vector3().crossVectors(u, f);
    if (want.lengthSq() > 1e-6) {
      hinge.addScaledVector(u, -hinge.dot(u)).normalize();
      want.normalize();
      const ang = Math.atan2(new THREE.Vector3().crossVectors(hinge, want).dot(u), hinge.dot(want));
      turn.premultiply(new THREE.Quaternion().setFromAxisAngle(u, ang));
    }
    const upWorld = turn.clone().multiply(a.upRest);
    const bent = a.loDir.clone().applyQuaternion(turn);
    const loWorld = new THREE.Quaternion().setFromUnitVectors(bent, f).multiply(turn).multiply(a.loRest);
    const pq = a.up.parent.getWorldQuaternion(new THREE.Quaternion());
    const upLocal = pq.clone().invert().multiply(upWorld);
    a.up.quaternion.slerp(upLocal, w);
    a.up.updateWorldMatrix(false, false);
    const uq = a.up.getWorldQuaternion(new THREE.Quaternion());
    a.lo.quaternion.slerp(uq.invert().multiply(loWorld), w);
    // Where the fingers point, if it matters. The shortest turn from the T-pose keeps the palm down.
    if (spec.fingers) {
      a.lo.updateWorldMatrix(false, false);
      const lq = a.lo.getWorldQuaternion(new THREE.Quaternion()).invert();
      const want = new THREE.Quaternion().setFromUnitVectors(a.haDir, new THREE.Vector3(...spec.fingers).normalize()).multiply(a.haRest);
      a.ha.quaternion.slerp(lq.multiply(want), w);
    }
    return T;
  }

  handAt(side) { return this.sides[side]?.ha.getWorldPosition(new THREE.Vector3()) || null; }
}

// How far down the arms can hang on this body without the hands going into the hips. Bodies differ too
// much for one angle: measure the hip width from the vertices the hips and thighs actually move (so long
// hair doesn't count), take the arm's length, and leave a small gap. Measured in the T-pose it loads in.
const HANG_MOST = 1.4, HANG_LEAST = 1.22, HAND_GAP = 0.09; // of the arm's length: half a hand, and a little air
function armHang(vrm) {
  const raw = (b) => vrm.humanoid?.getRawBoneNode(b);
  const norm = (b) => vrm.humanoid?.getNormalizedBoneNode(b);
  const hips = raw('hips'), arm = norm('rightUpperArm'), fore = norm('rightLowerArm'), hand = norm('rightHand');
  if (!hips || !arm || !fore || !hand) return { hang: 1.32, halfWidth: 0.15, waist: 0.13 };
  vrm.scene.updateMatrixWorld(true);
  const at = (o) => o.getWorldPosition(new THREE.Vector3());
  const body = new Set([hips, raw('leftUpperLeg'), raw('rightUpperLeg')].filter(Boolean));
  const centre = at(hips).x;
  const hipY = at(hips).y;
  const band = Math.max(0.05, at(raw('head') || hips).y - hipY) * 0.28; // the hips, not the torso or knees
  const a = at(arm), f = at(fore), h = at(hand);
  const length = a.distanceTo(f) + f.distanceTo(h) + 0.08; // to the knuckles
  const v = new THREE.Vector3();
  let halfWidth = 0;
  let waist = 0;
  const torso = new Set([hips, raw('spine'), raw('chest')].filter(Boolean));
  const tall = new THREE.Box3().setFromObject(vrm.scene).getSize(new THREE.Vector3()).y;
  vrm.scene.traverse((m) => {
    if (!m.isSkinnedMesh) return;
    const pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    if (!pos || !si || !sw) return;
    const step = Math.max(1, Math.floor(pos.count / 40000));
    for (let i = 0; i < pos.count; i += step) {
      let best = 0;
      for (let j = 1; j < 4; j++) if (sw.getComponent(i, j) > sw.getComponent(i, best)) best = j;
      const bone = m.skeleton.bones[si.getComponent(i, best)];
      if (!body.has(bone) && !torso.has(bone)) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      // The waist, at the height a hand rests on it.
      if (torso.has(bone) && v.y > hipY + 0.05 * tall && v.y < hipY + 0.11 * tall) waist = Math.max(waist, Math.abs(v.x - centre));
      if (!body.has(bone)) continue;
      if (Math.abs(v.y - hipY) > band) continue;
      halfWidth = Math.max(halfWidth, Math.abs(v.x - centre));
    }
  });
  const reach = (halfWidth + HAND_GAP * length - Math.abs(a.x - centre)) / length;
  const angle = Math.acos(Math.min(1, Math.max(-1, reach)));
  return { hang: THREE.MathUtils.clamp(angle, HANG_LEAST, HANG_MOST), halfWidth, waist: waist || halfWidth };
}

// A clip that needs a pole (the store's pole dance): one stands beside the body while it plays.
// The README's spot, avatar at the origin facing +Z, fits only the body it was keyed on (LANAgent
// measured the hands at X -0.28 on a model with 0.81 m hips), so the spot is fitted to each body.
export const POLE_CLIP = /(^|[-_])pole([-_]|$)/;
const POLE_SPOT = new THREE.Vector3(-0.40, 0, 0);
const POLE_SAMPLES = 120;
function median(v) { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function makePole() {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.0225, 0.0225, 3, 24),
    new THREE.MeshStandardMaterial({ color: 0xd9dee4, metalness: 0.55, roughness: 0.3 }));
  pole.name = 'avatarx-pole';
  pole.visible = false;
  pole.frustumCulled = false;
  return pole;
}

export class Motion {
  constructor(vrm) {
    this.vrm = vrm;
    this.hum = vrm.humanoid;
    const measured = armHang(vrm);
    this.hang = measured.hang;
    this.halfWidth = measured.halfWidth;
    this.waist = measured.waist;
    this.ik = new ArmIK(vrm, measured.waist);
    this.lastReach = {};
    window.__armHang = this.hang;
    this.rest = new Map();
    this.touched = new Set();
    this.hipsRest = this.node('hips')?.position.clone();
    this.idleSample = null;
    this.idleT = 0;
    this.idleDur = 0;
    this.talkSample = null;
    this.talkName = '';
    this.talkT = 0;
    this.talkDur = 0;
    this.talkW = 0;
    this.talking = false;  // set by the page while the agent's voice is heard
    this.idleOn = false;
    this.fidget = null;
    this.nextFidget = 3 + Math.random() * 4;
    this.lastFidget = '';
    this.clip = null;      // { action, until, ... }
    this.props = new Props(vrm, (kind, note) => window.__report?.(kind, note));
    this.pole = makePole();
    this.pole.userData.notBody = true;
    this.poleAt = new Map();  // clip name -> [x, z] in the model's own space
    vrm.scene.add(this.pole);
    window.__pole = () => ({ visible: this.pole.visible, x: this.pole.position.x, z: this.pole.position.z, clip: this.clip?.name || null });
    // What is driving the body now: the clip's own time and weight, the idle, a fidget, a gesture.
    // For tests on a real page: world rotations of named bones, the hips' place, and the springs' tips.
    window.__pose = (names) => {
      const q = new THREE.Quaternion(), p = new THREE.Vector3();
      const raw = (b) => this.hum?.getRawBoneNode(b);
      const joints = [...(this.vrm.springBoneManager?.joints || [])].slice(0, 400);
      return { bones: Object.fromEntries(names.map((b) => [b, raw(b) ? raw(b).getWorldQuaternion(q).toArray() : null])),
        hips: raw('hips') ? raw('hips').getWorldPosition(p).toArray() : null,
        springs: joints.map((j) => j.bone.getWorldPosition(new THREE.Vector3()).toArray()) };
    };
    window.__motion = () => ({ clip: this.clip?.name || null, t: this.clip?.t ?? null, actionTime: this.clip ? Math.min(this.clip.t, this.clip.duration) : null,
      weight: this.clip ? smooth(this.clip.t / 0.5) * smooth((this.clip.duration - this.clip.t) / 0.6) : 0,
      idle: this.idleOn ? this.idleName : null, idleW: this.idleW, talk: this.talkName || null, talkW: +this.talkW.toFixed(3), idleT: this.idleT, hipsQ: this.node('hips')?.quaternion.toArray().map((v) => +v.toFixed(3)), fidget: !!this.fidget, gesture: this.gesture?.name || null,
      eyes: this.vrm.lookAt ? { follow: this.vrm.lookAt.autoUpdate, yaw: +this.vrm.lookAt.yaw.toFixed(2), pitch: +this.vrm.lookAt.pitch.toFixed(2) } : null });
    this.gesture = null;   // { def, t }
    this.thinking = 0;
    this.thinkingOn = false;
    this.t = 0;
    this.shift = 0;
    this.headYaw = 0;
    this.headPitch = 0;
  }

  node(name) { return this.hum?.getNormalizedBoneNode(name) || null; }

  play(name) {
    const def = GESTURES[name];
    if (def) {
      // One motion at a time: a built-in gesture ends a clip (and its pole) rather than layering on it.
      this.clip = null;
      this.gesture = { name, def, t: 0 }; this.lastReach = {}; return true;
    }
    return false;
  }

  // Bones only: the face stays with the mood, the blink and the voice.
  async boneClip(name) {
    const c = await loadClip(name);
    if (c.fbx) return fitFbx(c.fbx, this.vrm);
    if (!c.vrma) throw new Error(`no animation in clip ${name}`);
    const raw = createVRMAnimationClip(c.vrma, this.vrm);
    return new THREE.AnimationClip(raw.name, raw.duration, raw.tracks.filter((t) => !/morphTargetInfluences|expression/i.test(t.name) && !t.name.includes('VRMExpression') && !t.name.includes('VRMLookAt')));
  }

  // An idle clip the owner chose in Settings loops under everything. Its hips keep their bounce and
  // sway (that is what moves the hair and the body's springs), centred on where this body stands: a
  // clip's own hip height once threw the body 0.56 m up, which was the offset, not the movement.
  // A looping clip's tracks as a standing loop uses them: hips position re-centred on where this body
  // stands, every other position dropped.
  loopTracks(clip) {
    const rest = this.hipsRest;
    return clip.tracks.flatMap((t) => {
      if (!t.name.endsWith('.position')) return [t];
      if (!rest || !t.name.startsWith(this.node('hips')?.name + '.')) return [];
      const v = t.values, n = v.length / 3, mean = [0, 0, 0];
      for (let i = 0; i < v.length; i++) mean[i % 3] += v[i] / n;
      const at = [rest.x, rest.y, rest.z];
      return [new THREE.VectorKeyframeTrack(t.name, t.times, Array.from(v, (x, i) => x - mean[i % 3] + at[i % 3]))];
    });
  }

  // The talk loop (a store clip like talk-loop): it plays while the agent speaks, blended over the
  // standing pose, and fades back when it stops (operator, 2026-11-11). No clip: nothing changes.
  async useTalk(name) {
    this.talkName = name || '';
    if (!name) { this.talkSample = null; return; }
    const clip = await this.boneClip(name);
    if (this.talkName !== name) return;
    this.talkSample = sampler(new THREE.AnimationClip(clip.name, clip.duration, this.loopTracks(clip)), this.vrm.scene);
    this.talkT = 0;
    this.talkDur = clip.duration;
  }

  async useIdle(name) {
    this.idleSample = null;
    this.idleOn = false;
    this.idleName = name || '';
    if (!name) return;
    const clip = await this.boneClip(name);
    if (this.idleName !== name) return;
    const rest = this.hipsRest;
    const tracks = clip.tracks.flatMap((t) => {
      if (!t.name.endsWith('.position')) return [t];
      if (!rest || !t.name.startsWith(this.node('hips')?.name + '.')) return [];
      const v = t.values, n = v.length / 3, mean = [0, 0, 0];
      for (let i = 0; i < v.length; i++) mean[i % 3] += v[i] / n;
      const at = [rest.x, rest.y, rest.z];
      return [new THREE.VectorKeyframeTrack(t.name, t.times, Array.from(v, (x, i) => x - mean[i % 3] + at[i % 3]))];
    });
    this.idleSample = sampler(new THREE.AnimationClip(clip.name, clip.duration, tracks), this.vrm.scene);
    this.idleT = 0;
    this.idleDur = clip.duration;
    this.idleOn = true;
  }

  // Where this body's hands hold the pole: the routine sampled on this model, hand (middle knuckle)
  // positions near the README's spot, their median, refined twice. Few points near it: the spot stays.
  polePoint(clip) {
    const root = this.vrm.scene;
    const start = root.worldToLocal(POLE_SPOT.clone());
    const bones = ['left', 'right'].map((s) => this.hum.getRawBoneNode(`${s}MiddleProximal`) || this.hum.getRawBoneNode(`${s}Hand`)).filter(Boolean);
    const sample = sampler(clip, root);
    const pts = [], p = new THREE.Vector3();
    for (let i = 0; i < POLE_SAMPLES; i++) {
      sample((clip.duration * i) / POLE_SAMPLES);
      this.hum.update();
      root.updateMatrixWorld(true);
      for (const b of bones) { root.worldToLocal(b.getWorldPosition(p)); pts.push([p.x, p.z]); }
    }
    for (const b of Object.keys(this.hum?.humanBones || {})) this.touched.add(b);
    let c = [start.x, start.z];
    for (let k = 0; k < 3; k++) {
      const near = pts.filter(([x, z]) => Math.hypot(x - c[0], z - c[1]) < 0.25);
      if (near.length < POLE_SAMPLES / 4) break;
      c = [median(near.map((q) => q[0])), median(near.map((q) => q[1]))];
    }
    // A pole through the body is never right: hands that stay close in give the README's spot.
    const body = root.worldToLocal(new THREE.Vector3(0, 0, 0));
    return Math.hypot(c[0] - body.x, c[1] - body.z) < 0.15 ? [start.x, start.z] : c;
  }

  // LANAgent: seconds: repeat whole passes for at least that long (a 4.8 s dance is over before it is seen).
  async playClip(name, seconds) {
    const clip = await this.boneClip(name);
    if (POLE_CLIP.test(name) && !this.poleAt.has(name)) this.poleAt.set(name, this.polePoint(clip));
    const at = this.poleAt.get(name);
    if (at) this.pole.position.set(at[0], 1.5, at[1]);
    this.clip = { sample: sampler(clip, this.vrm.scene), fresh: true, t: 0, duration: clip.duration, total: Math.max(1, seconds > 0 ? Math.ceil(Math.min(seconds, 150) / clip.duration - 0.05) : 1) * clip.duration, name, pole: !!at };
    this.gesture = null;
    this.fidget = null;  // a fidget begun just before would otherwise play over the clip
  }

  // level: how loud the voice is now, 0..1. look: {x, y} in head-turn terms, -1..1.
  update(dt, level, look) {
    dt = Math.min(dt, 0.1);  // a stalled frame (a clip being prepared) must not jump the motion ahead
    this.t += dt;
    const t = this.t;
    // 1. Back to rest.
    for (const name of this.touched) { const n = this.node(name); if (n) n.quaternion.identity(); }
    this.touched.clear();
    for (const [name, v] of Object.entries(REST)) this.setTo(name, v, 1);
    this.setTo('leftUpperArm', [0.05, -0.12, -this.hang], 1);
    this.setTo('rightUpperArm', [0.05, 0.12, this.hang], 1);
    const hips = this.node('hips');
    if (hips && this.hipsRest) hips.position.copy(this.hipsRest);
    // The standing loop holds still while a clip plays, so the clip blends from one fixed pose and back
    // to it: dropping the loop first passed the arms through the rest pose (a 59-degree jump in one
    // frame), and blending from a loop still moving (Roger Rabbit's elbows) flapped them.
    this.idleW = 1;
    if (this.idleOn) {
      if (!this.clip) this.idleT = this.idleDur > 0 ? (this.idleT + dt) % this.idleDur : 0;
      this.idleSample?.(this.idleT);
      for (const b of Object.keys(this.hum?.humanBones || {})) this.touched.add(b);
    }

    // 1b. Talking: the talk loop fades in over the standing pose while the agent speaks, and out after.
    // A move (clip or head gesture) wins over it.
    const wantTalk = this.talking && this.talkSample && !this.clip && !this.gesture;
    this.talkW += ((wantTalk ? 1 : 0) - this.talkW) * Math.min(1, dt * 3);
    if (this.talkSample && this.talkW > 0.002) {
      const base = [];
      for (const b of Object.keys(this.hum?.humanBones || {})) {
        const n = this.node(b);
        if (n) base.push([b, n, n.quaternion.clone()]);
      }
      const hipsBase = hips?.position.clone();
      this.talkT = this.talkDur > 0 ? (this.talkT + dt) % this.talkDur : 0;
      this.talkSample(this.talkT);
      for (const [b, n, q0] of base) { n.quaternion.copy(q0.slerp(n.quaternion, this.talkW)); this.touched.add(b); }
      if (hips && hipsBase) hips.position.lerpVectors(hipsBase, hips.position, this.talkW);
    }

    // 2. A clip, faded in and out over the standing pose (the loop's, else the rest pose).
    if (this.clip) {
      const c = this.clip;
      if (c.fresh) c.fresh = false; else c.t += dt;  // its first frame starts at 0: the frame that prepared it was long
      const w = smooth(c.t / 0.5) * smooth((c.total - c.t) / 0.6);
      const keep = [];
      for (const b of Object.keys(this.hum?.humanBones || {})) {
        const n = this.node(b);
        if (n) keep.push([b, n, n.quaternion.clone()]);
      }
      const hipsBefore = hips?.position.clone();
      c.at = c.t >= c.total ? c.duration : c.total > c.duration ? c.t % c.duration : c.t;
      c.sample(c.at);
      for (const [b, n, restQ] of keep) {
        n.quaternion.copy(restQ.slerp(n.quaternion, w));
        this.touched.add(b);
      }
      if (hips && hipsBefore) hips.position.lerpVectors(hipsBefore, hips.position, w);
      if (c.t >= c.total) this.clip = null;
    }
    const clipWeight = this.clip ? smooth(this.clip.t / 0.5) * smooth((this.clip.total - this.clip.t) / 0.6) : 0;
    // Props follow whichever clip shows most: a clip, else the talk loop, else the standing loop.
    // A video (propsClipOnly) shows a prop only with its own move: a loop fading in at the end of a
    // spoken line made the mic pop in for a moment (owner, 2026-11-15).
    const active = [];
    // LANAgent: each clip's own time goes along, for the store's `show` windows (2119 #539), and the frame's dt for a
    // prop's own animation.
    if (this.clip) active.push({ name: this.clip.name, weight: clipWeight, t: this.clip.at ?? this.clip.t });
    if (!this.propsClipOnly && this.talkName && this.talkSample) active.push({ name: this.talkName, weight: this.talkW, t: this.talkT });
    if (!this.propsClipOnly && this.idleOn && this.idleName) active.push({ name: this.idleName, weight: 1 - clipWeight - this.talkW, t: this.idleT });
    try { this.props.update(active, dt); } catch (err) { /* a prop never stops the body */ }
    this.pole.visible = !!this.clip?.pole && !this.props.replacesPole(this.clip.name);
    // A standing clip plays as it was made: nothing in code moves the body over it.
    const life = (1 - clipWeight) * (this.idleOn ? 0 : 1) * (1 - this.talkW);

    // 3. Breath, a slow shift of weight from foot to foot, arms that hang and swing a little.
    const own = life;
    const shift = wob(t, 0.33, 1) + wob(t, 0.13, 0.5);
    if (hips && this.hipsRest) hips.position.x += shift * 0.012 * own;
    this.add('hips', [0, wob(t, 0.21, 0.035) * own, shift * 0.018 * own]);
    this.add('spine', [wob(t, 1.3, 0.008) * own, wob(t, 0.27, 0.02) * own, -shift * 0.012 * own]);
    this.add('chest', [wob(t, 1.3, 0.02) * own, -wob(t, 0.21, 0.015) * own, -shift * 0.012 * own]);
    this.add('head', [wob(t, 0.41, 0.012) * own, wob(t, 0.23, 0.02) * own, wob(t, 0.31, 0.012) * own]);
    this.add('leftUpperArm', [wob(t, 0.73, 0.03) * own, 0, wob(t, 1.3, 0.012) * own + shift * 0.012 * own]);
    this.add('rightUpperArm', [wob(t + 1.3, 0.67, 0.03) * own, 0, wob(t, 1.3, 0.012) * own + shift * 0.012 * own]);
    this.add('leftLowerArm', [0, -wob(t, 0.59, 0.05) * own, 0]);
    this.add('rightLowerArm', [0, wob(t + 2, 0.53, 0.05) * own, 0]);
    this.add('leftHand', [wob(t, 0.47, 0.05) * own, 0, 0]);
    this.add('rightHand', [wob(t + 1, 0.43, 0.05) * own, 0, 0]);

    // 4. Speaking: the head and hands move with the voice.
    if (level > 0.02) {
      const a = level * life;
      this.add('head', [wob(t, 4.3, 0.035) * a, wob(t, 2.1, 0.04) * a, wob(t, 1.7, 0.025) * a]);
      this.add('chest', [wob(t, 3.1, 0.012) * a, wob(t, 1.9, 0.02) * a, 0]);
      this.add('rightLowerArm', [0, (0.25 + wob(t, 3.2, 0.2)) * a, 0]);
      this.add('leftLowerArm', [0, -(0.25 + wob(t, 2.7, 0.2)) * a, 0]);
    }

    // 5. Waiting on a thought: the pose fades in after a moment.
    this.thinking += ((this.thinkingOn ? 1 : 0) - this.thinking) * Math.min(1, dt * 3);
    if (this.thinking > 0.01 && life > 0.5) this.blend(THINK, this.thinking * 0.9);

    // 6. Looking at you, before a gesture so that a nod still reads.
    const yaw = THREE.MathUtils.clamp(look.x, -1, 1) * 0.5;
    const pitch = THREE.MathUtils.clamp(-look.y, -0.45, 1) * 0.28; // mostly level: little looking up
    const k = Math.min(1, dt * 5);
    this.headYaw += (yaw - this.headYaw) * k;
    this.headPitch += (pitch - this.headPitch) * k;
    this.add('head', [this.headPitch * life * 0.8, this.headYaw * life * 0.8, 0]);
    this.add('neck', [this.headPitch * life * 0.2, this.headYaw * life * 0.2, 0]);

    // A small unprompted movement now and then, unless something else is going on.
    if (!this.fidget && !this.gesture && !this.clip && !this.idleOn && !this.thinkingOn && level < 0.02) {
      this.nextFidget -= dt;
      if (this.nextFidget <= 0) {
        const names = Object.keys(FIDGETS).filter((n) => n !== this.lastFidget);
        const n = names[Math.floor(Math.random() * names.length)];
        this.lastFidget = n;
        this.fidget = { def: FIDGETS[n], t: 0 };
        this.nextFidget = 5 + Math.random() * 8;
      }
    }
    if (this.fidget) {
      const f = this.fidget;
      f.t += dt;
      const r = f.t / f.def.seconds;
      for (const [b, v] of Object.entries(f.def.pose(Math.min(1, r)))) this.add(b, v);
      if (r >= 1) this.fidget = null;
    }

    // 7. A gesture.
    if (this.gesture) {
      const g = this.gesture;
      g.t += dt;
      const d = g.def.seconds;
      const w = smooth(g.t / 0.3) * smooth((d - g.t) / 0.4);
      this.blend(g.def.pose(g.t / d, g.t), w);
      if (g.t >= d) this.gesture = null;
    }
  }

  setTo(name, v, w) {
    const n = this.node(name);
    if (!n) return;
    this.touched.add(name);
    if (w >= 1) n.quaternion.copy(toQ(v));
    else n.quaternion.slerp(toQ(v), w);
  }

  add(name, v) {
    const n = this.node(name);
    if (!n) return;
    this.touched.add(name);
    n.quaternion.multiply(q.setFromEuler(e.set(v[0], v[1], v[2])));
  }

  blend(pose, w) {
    for (const [b, v] of Object.entries(pose)) if (b !== 'ik') this.setTo(b, v, w);
    if (!pose.ik) return;
    for (const [side, spec] of Object.entries(pose.ik)) {
      this.touched.add(`${side}UpperArm`); this.touched.add(`${side}LowerArm`); this.touched.add(`${side}Hand`);
      const T = this.ik.solve(side, spec, w);
      // Near the peak, record how far the hand is from where it was sent: the tests read this.
      if (T && w > 0.98) this.lastReach[side] = { spec: spec.at, miss: this.ik.handAt(side).distanceTo(T), height: this.ik.height };
    }
  }
}
