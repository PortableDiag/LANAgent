// Props: small glTF models (a phone, a mug, a chair) that a clip holds or stands beside. Each comes with
// placements per clip (store.rs parse_attach): a VRM humanoid bone, in VRM 1.0's normalized bone space
// (+Y up, +Z the model's forward), or "floor", in the avatar's own space; position in metres, rotation
// in degrees (XYZ), the .glb's origin at its grip or contact point. A prop shows only while a clip it
// names plays. No props, or one that fails to load, and every clip plays exactly as before.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const DEG = Math.PI / 180;
const cache = new Map();  // "name@rev" -> Promise<THREE.Object3D | null>

function loadModel(name, rev) {
  const key = `${name}@${rev}`;
  if (!cache.has(key)) {
    cache.set(key, fetch(`/api/props/${encodeURIComponent(name)}/file`).then(async (r) => {
      if (!r.ok) throw new Error(`the server answered ${r.status}`);
      const g = await new GLTFLoader().parseAsync(await r.arrayBuffer(), '');
      const root = g.scene || g.scenes?.[0];
      if (!root) throw new Error('no scene in the model');
      root.traverse((o) => { o.frustumCulled = false; });
      root.userData.lanagentAnimations = g.animations || []; // LANAgent: the prop's own animations (prop_loop / prop_anim)
      return root;
    }).catch((err) => { cache.delete(key); throw err; }));
  }
  return cache.get(key);
}

// A talk loop (talk-loop, talk-loop-2, store-talk-loop...): ordinary talking. It never brings a prop
// unless the move is a performance (owner, 2026-11-15: no mic for normal talking).
export const TALK_LOOP = /(^|[-_])talk[-_]loop([-_]\d+)?$/;
export function isTalk(name) { return clipKeys(name).some((k) => TALK_LOOP.test(k)); }

// A clip's name as a prop lists it: the page may hold it as bnb-<name> (named after a built-in), and
// a broad version as <name>-broad.
export function clipKeys(name) {
  if (!name) return [];
  const keys = [name];
  const bare = name.replace(/^bnb-/, '');
  if (bare !== name) keys.push(bare);
  for (const k of [...keys]) if (k.endsWith('-broad')) keys.push(k.slice(0, -6));
  return keys;
}

export class Props {
  constructor(vrm, report = () => {}) {
    this.vrm = vrm;
    this.report = report;
    this.list = [];       // [{name, rev, clips, fits}]
    this.held = new Map(); // name -> { rev, obj, holder, at }
    this.hash = null;     // the worn VRM's sha256, for per-body fits
    this.performance = false;  // a performance video: talk loops may bring their props
    // A VRM 0.x model faces -Z in its own (and its normalized bones') space; VRM 1.0 faces +Z. Placements
    // are written for 1.0, so on a 0.x model a bone prop's frame turns half a circle first.
    this.flip = vrm.meta?.metaVersion === '0';
    // This body's standing hip height (rest pose, metres above its feet), for placements made to scale.
    this.hips = (() => {
      try {
        vrm.scene.updateMatrixWorld(true);
        const h = vrm.humanoid?.getNormalizedBoneNode('hips')?.getWorldPosition(new THREE.Vector3());
        const root = vrm.scene.getWorldPosition(new THREE.Vector3());
        return h ? h.y - root.y : null;
      } catch { return null; }
    })();
    // Floor props stand in the avatar's space as the viewer sees it (+Z forward), whatever the file's.
    this.floor = new THREE.Group();
    this.floor.name = 'avatarx-props-floor';
    this.floor.userData.notBody = true;
    vrm.scene.add(this.floor);
    this.floor.quaternion.copy(vrm.scene.quaternion).invert();
    // For tests on a real page: each prop, whether it shows, where it is and where its bone is.
    window.__props = () => [...this.held].map(([n, h]) => {
      const w = (o) => (o ? o.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(4)) : null);
      return { name: n, loaded: !!h.frame, visible: !!h.frame?.visible, bone: h.at?.bone || null,
        parent: h.frame?.parent?.name || null, at: w(h.holder), boneAt: w(h.frame?.parent), rev: h.rev, scale: +h.holder?.scale.x.toFixed(4), hips: this.hips };
    });
  }

  // The props in the state: new ones load, gone ones go. Loading never blocks a clip.
  sync(list) {
    this.list = Array.isArray(list) ? list : [];
    const want = new Set(this.list.map((p) => p.name));
    for (const [n, h] of this.held) {
      if (!want.has(n) || this.list.find((p) => p.name === n).rev !== h.rev) this.drop(n);
    }
    return Promise.all(this.list.filter((p) => !this.held.has(p.name)).map((p) => this.load(p)));
  }

  async load(p) {
    const slot = { rev: p.rev, obj: null, frame: null, holder: null, at: null };
    this.held.set(p.name, slot);
    try {
      const model = await loadModel(p.name, p.rev);
      if (this.held.get(p.name) !== slot) return;
      const obj = model.clone(true);
      slot.animations = model.userData.lanagentAnimations || []; // LANAgent: clone() would JSON-copy them, so kept here
      // frame: the bone's (or the floor's) space turned to VRM 1.0's; holder: the placement in it.
      const frame = new THREE.Group();
      frame.name = `avatarx-prop-${p.name}`;
      frame.userData.notBody = true;
      frame.visible = false;
      const holder = new THREE.Group();
      holder.add(obj);
      frame.add(holder);
      slot.obj = obj;
      slot.frame = frame;
      slot.holder = holder;
    } catch (err) {
      this.report('prop_failed', `${p.name}: ${err.message}`);
    }
  }

  drop(name) {
    const h = this.held.get(name);
    h?.frame?.parent?.remove(h.frame);
    this.held.delete(name);
  }

  // Wait for the props these clips use (a video's first frame must have its phone in hand).
  async ready(names, ms = 15000) {
    const keys = new Set(names.flatMap(clipKeys));
    const pending = this.list.filter((p) => Object.keys(p.clips || {}).some((c) => keys.has(c)));
    const until = performance.now() + ms;
    while (pending.some((p) => !this.held.get(p.name)?.frame) && performance.now() < until) {
      if (pending.every((p) => !this.held.has(p.name))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // The prop's placement for a clip, the worn body's own fit first.
  placementFor(p, clip) {
    for (const k of clipKeys(clip)) {
      const fit = this.hash && p.fits?.[this.hash]?.clips?.[k];
      if (fit) return fit;
      if (p.clips?.[k]) return p.clips[k];
    }
    return null;
  }

  // Does a prop take this clip's place for the built-in pole?
  replacesPole(clip) {
    const p = this.list.find((x) => x.name === 'pole');
    return !!(p && this.placementFor(p, clip) && this.held.get('pole')?.frame);
  }

  // active: the clips driving the body now, the one that shows most first ([{name, weight}]).
  update(active, dt = 0) {
    for (const p of this.list) {
      const h = this.held.get(p.name);
      if (!h?.frame) continue;
      let at = null;
      for (const a of active) {
        if (isTalk(a.name) && !this.performance) continue;
        // Shown from a quarter in and kept to a tenth out, so a weight hovering near one line never flickers.
        if (a.weight < (h.frame.visible ? 0.1 : 0.25)) continue;
        const found = this.placementFor(p, a.name);
        // LANAgent: `show: [t_on, t_off]` (store 2119 #539): only while the hand holds it in this clip.
        if (found && Array.isArray(found.show) && found.show.length === 2 && typeof a.t === 'number' && (a.t < found.show[0] || a.t > found.show[1])) continue;
        at = found;
        if (at) break;
      }
      if (!at) { h.frame.visible = false; continue; }
      const floor = at.bone === 'floor';
      const parent = floor ? this.floor : this.vrm.humanoid?.getNormalizedBoneNode(at.bone);
      if (!parent) { h.frame.visible = false; continue; }
      if (h.frame.parent !== parent) {
        parent.add(h.frame);
        h.frame.rotation.set(0, this.flip && !floor ? Math.PI : 0, 0);
      }
      if (h.at !== at) {
        const k = at.scale_with === 'body' && at.ref_hips > 0 && this.hips > 0.1 ? this.hips / at.ref_hips : 1;
        const [x, y, z] = at.position || [0, 0, 0];
        const [rx, ry, rz] = at.rotation || [0, 0, 0];
        h.holder.position.set(x * k, y * k, z * k);
        h.holder.rotation.set(rx * DEG, ry * DEG, rz * DEG, 'XYZ');
        h.holder.scale.setScalar((at.scale || 1) * k);
        h.at = at;
      }
      h.frame.visible = true;
      // LANAgent: the prop's own glTF animation, looped while it shows (prop_loop) or played once (prop_anim).
      const want = at.prop_loop?.name || at.prop_loop || at.prop_anim?.name || at.prop_anim;
      if (typeof want === 'string' && h.animName !== want) {
        const clip = (h.animations || []).find(c => c.name === want);
        h.mixer = clip ? new THREE.AnimationMixer(h.obj) : null;
        if (clip) { const act = h.mixer.clipAction(clip); if (!at.prop_loop) { act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; } act.play(); }
        h.animName = want;
      }
      if (h.mixer && dt > 0) h.mixer.update(dt);
    }
  }

  dispose() {
    for (const n of [...this.held.keys()]) this.drop(n);
    this.floor.parent?.remove(this.floor);
  }
}
