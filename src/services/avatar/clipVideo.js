/**
 * A video of the agent's own 3D body doing a clip (a dance, a wave, the pole dance), to send to the owner.
 *
 * Rendered on this machine in a headless browser, frame by frame at a fixed step: the spring bones (hair) settle the
 * same way at any speed, and nothing depends on how fast the machine draws. The page code is the avatar designer's
 * own (loadVRMA with its face tracks, the pole fit), lifted from avatar.html when a render starts, so a video moves
 * exactly as the designer and the playground do. The .vrm and .vrma never leave the machine: only the video does,
 * which the store's licence allows ("streams, videos").
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import { moveProblem } from '../../interfaces/web/public/lib/bnb-camera.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../interfaces/web/public');
const METHODS = ['_getBone', 'loadVRMA', '_fitPoleSpot'];

/** The named methods of the designer's class, as text, from avatar.html. Throws when one is missing. */
export function designerMethods(html, names = METHODS) {
  return names.map((name) => {
    const head = new RegExp(`\\n        (?:async )?${name}\\([^)]*\\) \\{`).exec(html);
    if (!head) throw new Error(`avatar.html has no ${name}()`);
    const start = head.index + 1;
    const end = html.indexOf('\n        }\n', start);
    if (end < 0) throw new Error(`avatar.html: ${name}() never closes`);
    return html.slice(start, end + '\n        }'.length);
  }).join(',\n');
}

/**
 * With a voice-over the speech sets the length (the owner, 2026-11-15: "the video length and action needs to match
 * the audio length"). A looping clip runs while the voice speaks plus a short tail; a one-off move plays through
 * if it is longer than the speech.
 */
export function spokenSeconds(duration, loop, voiceSeconds, max = VOICE_MAX_S) {
  // A 0.3 s lead-in, the line, a 0.3 s tail, no longer (2119 #477, the same as Orbit's AvatarX 0.3.14): a move longer
  // than the line is cut, a shorter one holds its last pose (a loop keeps looping).
  const t = Math.max(1.5, VOICE_LEAD_S + Number(voiceSeconds) + VOICE_TAIL_S);
  return Math.min(Math.round(t * 100) / 100, max);
}
const VOICE_LEAD_S = 0.3;
const VOICE_TAIL_S = 0.3;

/** The words of a request that ask for a closer shot: 'waist', 'head', or 'full' (head to toe, the default). */
export function framingAsked(text = '') {
  const t = String(text);
  if (/\b(?:head and shoulders|head-and-shoulders|headshot|close[- ]?up|just (?:your|the) (?:face|head)|face only)\b/i.test(t)) return 'head';
  if (/\b(?:waist[- ]up|from the waist|half[- ]body|upper body|torso)\b/i.test(t)) return 'waist';
  return 'full';
}

/** How long the video runs: one pass of a long clip, a few passes of a short loop, never past `max`. */
export function videoSeconds(duration, loop, { seconds = null, max = 40 } = {}) {
  if (seconds) return Math.min(Number(seconds), max);
  if (!(duration > 0)) return 0;
  if (!loop) return Math.min(Math.round((duration + 0.6) * 100) / 100, max);
  return Math.min(Math.max(duration, Math.min(duration * Math.ceil(6 / duration), 12)), max);
}

function pageHtml(methods) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head><body>
<script src="/lib/three.r183.min.js"></script>
<script type="importmap">{ "imports": { "three": "/lib/three.r183.module.js", "three/addons/": "/lib/addons/" } }</script>
<script type="module">
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as V from '/lib/three-vrm.module.js';
import { attachProps, updateProps } from '/lib/vrm-props.js';
import { wearLook } from '/lib/vrm-look.js';
import { jawDriver } from '/lib/vrm-jaw.js';
import { moveAt, viewFor, hiddenAt, pullFor, moveWithin, lightAt } from '/lib/bnb-camera.js';
const THREE = window.THREE; THREE.GLTFLoader = GLTFLoader;
const d = {
${methods}
};
window.setup = async ({ width, height, fps, seconds, loop, prop, props = [], background, backgroundImage = false, mouth = null, framing = 'full', look = null, camera = null, set = null }) => {
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1); r.setSize(width, height); document.body.appendChild(r.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  // A background scene (Bots & Borgs backgrounds): cover the frame, cropped to its shape, never stretched.
  // With a moving camera a picture pinned to the screen looks like a turntable in front of a wall that never moves: it
  // goes on a curved wall behind the body instead (below).
  if (backgroundImage && !set && !camera) {
    const tex = await new THREE.TextureLoader().loadAsync('/background.jpg');
    tex.colorSpace = THREE.SRGBColorSpace;
    const ia = tex.image.width / tex.image.height, va = width / height;
    if (ia > va) { tex.repeat.set(va / ia, 1); tex.offset.set((1 - va / ia) / 2, 0); } else { tex.repeat.set(1, ia / va); tex.offset.set(0, (1 - ia / va) / 2); }
    scene.background = tex;
  }
  let key;
  if (set && Array.isArray(set.lights) && set.lights.length) {
    // The set's own lights for the body (its own light is baked).
    const setMark = (set.marks || []).find(m => m.id === (set.mark || 'main')) || (set.marks || [])[0];
    const turn = -THREE.MathUtils.degToRad(Number(setMark?.facing_deg) || 0); // the set turns under the body, its lights with it
    for (const l of set.lights.slice(0, 8)) {
      const color = new THREE.Color(/^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : '#ffffff');
      const power = Math.min(Math.max(l.intensity == null ? 1 : Number(l.intensity) || 0, 0), 20);
      if (l.type === 'ambient') scene.add(new THREE.AmbientLight(color, power));
      else if (l.type === 'directional') {
        const at = set.kind === 'equirect' ? lightAt(l.at_deg, set.front_deg) : Array.isArray(l.from) && l.from.length === 3 ? l.from.map(Number) : null;
        if (!at || !at.every(Number.isFinite)) continue;
        const dl = new THREE.DirectionalLight(color, power);
        dl.position.set(...at).normalize().multiplyScalar(5).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn);
        // A sun near the horizon would throw a shadow ten meters long, past the floor that shows it: kept at 28 degrees.
        if (dl.position.y < 5 * Math.sin(0.49)) { const f = Math.hypot(dl.position.x, dl.position.z) || 1e-6, k = 5 * Math.cos(0.49) / f; dl.position.set(dl.position.x * k, 5 * Math.sin(0.49), dl.position.z * k); }
        scene.add(dl); key ||= dl;
      }
    }
  } else scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4050, 2.2));
  if (!key) { key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.2, 2.5, 2.5); scene.add(key); }
  if (!set) { const rim = new THREE.DirectionalLight(0x9fc4ff, 1.2); rim.position.set(-2, 2, -2); scene.add(rim); }
  const floor = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0.001; if (!set && !camera) scene.add(floor);
  const l = new GLTFLoader(); l.register(p => new V.VRMLoaderPlugin(p));
  const vrm = (await l.loadAsync(window.MODEL_URL || '/model.vrm')).userData.vrm;
  if (V.VRMUtils?.removeUnnecessaryJoints) V.VRMUtils.removeUnnecessaryJoints(vrm.scene);
  vrm.scene.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  scene.add(vrm.scene); d.currentVRM = vrm;
  vrm.update(0); vrm.scene.updateMatrixWorld(true);
  // Rest height (floor to the top of the head): the head bone sits at about 0.88 of it.
  const restHeight = Math.max((vrm.humanoid.getRawBoneNode('head')?.getWorldPosition(new THREE.Vector3()).y || 1.5) / 0.88, 0.2);
  // A 3D set: its main mark is put under the body, so the body, its clips and its props stay where they always are.
  let setRoot = null, limits = null, facing = 0;
  if (set) {
    const mark = (set.marks || []).find(m => m.id === (set.mark || 'main')) || (set.marks || [])[0] || { position: [0, 0, 0], facing_deg: 0 };
    setRoot = new THREE.Group();
    if (set.kind === 'equirect') {
      // A 360 picture, its lower half laid on the floor under the feet (as three.js's GroundedSkybox does): taken from
      // eye_height_m, flat out to ground_radius_m. front_deg: the image yaw (0 = center column, + = right) behind the body.
      const tex = await new THREE.TextureLoader().loadAsync('/set.img');
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      const eye = Math.min(Math.max(Number(set.eye_height_m) || 1.5, 0.3), 5), R = Math.min(Math.max(Number(set.ground_radius_m) || 12, 4), 40);
      const geo = new THREE.SphereGeometry(R, 128, 96); geo.scale(1, 1, -1);
      const at = geo.getAttribute('position'), q = new THREE.Vector3(), y1 = -eye * 1.5;
      for (let i = 0; i < at.count; i++) {
        q.fromBufferAttribute(at, i);
        if (q.y >= 0) continue;
        q.multiplyScalar(q.y < y1 ? -eye / q.y : 1 - (q.y * q.y) / (3 * y1 * y1)); q.toArray(at.array, 3 * i);
      }
      const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, depthWrite: false }));
      dome.position.y = eye; dome.renderOrder = -1;
      // The picture's center column sits at -Z (behind the body) after a quarter turn; front_deg turns it from there.
      dome.rotation.y = THREE.MathUtils.degToRad(90 + (Number(set.front_deg) || 0));
      setRoot.add(dome);
      setRoot.rotation.y = -THREE.MathUtils.degToRad(mark.facing_deg || 0);
    } else {
      const model = (await l.loadAsync('/set.glb')).scene;
      model.position.set(-(mark.position?.[0] || 0), -(mark.position?.[1] || 0) - (set.floor_y || 0), -(mark.position?.[2] || 0));
      setRoot.add(model);
      setRoot.rotation.y = -THREE.MathUtils.degToRad(mark.facing_deg || 0);
    }
    scene.add(setRoot); limits = set.camera?.[mark.id] || null; facing = Number(mark.facing_deg) || 0;
  } else if (camera && backgroundImage) limits = { arc_deg: [-35, 35] }; // past this the picture's edges show
  camera = moveWithin(camera, limits?.arc_deg);
  // The floor a moving camera sees: the body's shadow on it, and a plain floor under it when there is no set.
  if (set || camera) {
    r.shadowMap.enabled = true;
    vrm.scene.traverse(o => { if (o.isMesh) o.castShadow = true; });
    key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0006;
    Object.assign(key.shadow.camera, { left: -2.4, right: 2.4, top: 2.6, bottom: -2.4, near: 0.1, far: 14 }); key.shadow.camera.updateProjectionMatrix();
    const shade = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.ShadowMaterial({ opacity: 0.42 }));
    shade.rotation.x = -Math.PI / 2; shade.position.y = 0.006; shade.receiveShadow = true; scene.add(shade);
    if (!set) {
      let ground = new THREE.Color(background).lerp(new THREE.Color('#ffffff'), 0.08);
      if (backgroundImage) {
        const tex = await new THREE.TextureLoader().loadAsync('/background.jpg'); tex.colorSpace = THREE.SRGBColorSpace;
        const cv = document.createElement('canvas'); cv.width = 16; cv.height = 4; const g = cv.getContext('2d');
        g.drawImage(tex.image, 0, tex.image.height * 0.93, tex.image.width, tex.image.height * 0.07, 0, 0, 16, 4);
        const px = g.getImageData(0, 0, 16, 4).data; let q = [0, 0, 0];
        for (let i = 0; i < px.length; i += 4) for (let j = 0; j < 3; j++) q[j] += px[i + j];
        ground = new THREE.Color().setRGB(...q.map(n => n / (px.length / 4) / 255), THREE.SRGBColorSpace);
        // The picture on a curved wall behind the body, as wide as a +-60 degree pan sees (a 16:9 picture fits).
        const R = 4.2, arc = THREE.MathUtils.degToRad(150), h = (R * arc) / (tex.image.width / tex.image.height);
        tex.wrapS = THREE.RepeatWrapping; tex.repeat.x = -1;
        const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, h, 64, 1, true, Math.PI - arc / 2, arc), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide }));
        wall.position.y = h / 2 - 0.35; scene.add(wall);
        scene.background = ground.clone().multiplyScalar(0.5);
      }
      const ground3d = new THREE.Mesh(new THREE.CircleGeometry(backgroundImage ? 4.2 : 12, 64), new THREE.MeshBasicMaterial({ color: ground }));
      ground3d.rotation.x = -Math.PI / 2; ground3d.position.y = -0.002; scene.add(ground3d);
    }
  }
  // The owner's saved look for this body (linked avatars): pieces, colours, shape keys, on the outfit file.
  const worn = wearLook(vrm, look);
  const clip = await d.loadVRMA('/clip.vrma');
  if (!clip) throw new Error('the clip did not fit this model');
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const action = mixer.clipAction(clip);
  action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce); action.clampWhenFinished = true; action.play();
  // The pole (or other prop) where this body's hands meet it.
  let poleX = null;
  if (prop && prop.type === 'pole') {
    const spot = d._fitPoleSpot(vrm, clip) || { x: prop.x ?? -0.40, z: prop.z ?? 0 };
    const h = prop.height || 3, rad = prop.radius || 0.0225;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, h, 24), new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 0.9, roughness: 0.25 }));
    pole.position.set(spot.x, h / 2, spot.z); vrm.scene.add(pole); poleX = spot.x;
  }
  // Bought .glb props this clip uses (a phone in the hand, a chair): any that fail are left out, the clip still renders.
  const placed = await attachProps({ GLTFLoader, vrm, props, warn: (m) => console.warn(m), AnimationMixer: THREE.AnimationMixer, LoopOnce: THREE.LoopOnce });
  // Frame the whole routine: where the body goes over the clip, not just where it starts.
  const box = new THREE.Box3(); const v = new THREE.Vector3();
  const bones = ['head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'hips', 'leftUpperArm', 'rightUpperArm'];
  for (let i = 0; i <= 24; i++) {
    mixer.setTime((Math.min(seconds, clip.duration) * i) / 24); vrm.update(0); vrm.scene.updateMatrixWorld(true);
    for (const b of bones) { const n = vrm.humanoid.getRawBoneNode(b); if (n) box.expandByPoint(n.getWorldPosition(v)); }
  }
  box.expandByPoint(new THREE.Vector3(box.min.x, 0, box.min.z));
  box.max.y += 0.18; // the top of the head is above the head bone
  // Waist up or head and shoulders (2119 #477): frame only that part, over the whole clip.
  if (framing === 'waist' || framing === 'head') {
    const part = new THREE.Box3();
    const keep = framing === 'head' ? ['head', 'neck', 'leftShoulder', 'rightShoulder'] : ['head', 'hips', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand'];
    for (let i = 0; i <= 24; i++) {
      mixer.setTime((Math.min(seconds, clip.duration) * i) / 24); vrm.update(0); vrm.scene.updateMatrixWorld(true);
      for (const b of keep) { const n = vrm.humanoid.getRawBoneNode(b); if (n) part.expandByPoint(n.getWorldPosition(v)); }
    }
    const hips = vrm.humanoid.getRawBoneNode('hips')?.getWorldPosition(new THREE.Vector3());
    if (framing === 'waist' && hips) part.min.y = Math.max(part.min.y, hips.y - 0.08);
    if (framing === 'head') { const neck = vrm.humanoid.getRawBoneNode('neck')?.getWorldPosition(new THREE.Vector3()); if (neck) part.min.y = neck.y - 0.16; part.min.x -= 0.06; part.max.x += 0.06; }
    part.max.y += 0.18;
    box.copy(part);
  }
  if (poleX !== null) { box.expandByPoint(new THREE.Vector3(poleX, 0, 0)); }
  // A floor prop (a desk in front, a chair under) is part of the scene: a full-length shot frames it too, or a desk
  // between the camera and the body fills the frame. Hand props move with the hand and are already near the body.
  if (framing === 'full') for (const o of placed) if (o.userData?.floor) box.union(new THREE.Box3().setFromObject(o));
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const cam = new THREE.PerspectiveCamera(30, width / height, 0.05, 50);
  const fov = THREE.MathUtils.degToRad(30);
  const fitH = (s.y * 1.04) / 2 / Math.tan(fov / 2);
  const fitW = (s.x * 1.08) / 2 / Math.tan(fov / 2) / cam.aspect;
  // Closer framings get closer: the 1.2 m floor kept a head-and-shoulders shot at waist height.
  const dist = Math.max(fitH, fitW, framing === 'full' ? 1.2 : 0.45);
  const lookAt = new THREE.Vector3();
  if (backgroundImage && framing === 'full') {
    // In front of a room the body fills the frame like a giant (the owner, 2026-11-15). A person stands about 58% of
    // the height of a room shot, feet on the floor near the bottom: frame for that, the camera level with the middle.
    const room = Math.max((s.y / 0.58) / 2 / Math.tan(fov / 2), fitW * 1.15, 1.2);
    const view = 2 * room * Math.tan(fov / 2);
    const eye = view * 0.4; // the floor (y 0) sits 10% up from the bottom of the frame
    cam.position.set(c.x, eye, Math.max(c.z, box.max.z) + room); lookAt.set(c.x, eye, c.z);
  } else {
    cam.position.set(c.x, c.y + s.y * 0.04, Math.max(c.z, box.max.z) + dist); lookAt.set(c.x, c.y, c.z);
  }
  cam.lookAt(lookAt);
  // A floor prop standing between a front camera and the body (a standing desk) hides it from the chest down: look from
  // a 3/4 front-side angle instead (Bots & Borgs' default for its own previews, 2119 #504). Other shots stay front-on.
  const hipsAt = vrm.humanoid.getNormalizedBoneNode('hips')?.getWorldPosition(new THREE.Vector3());
  const blocking = hipsAt && placed.some(o => {
    if (!o.userData?.floor) return false;
    const b = new THREE.Box3().setFromObject(o);
    return b.min.z > hipsAt.z + 0.05 && b.min.x < hipsAt.x && b.max.x > hipsAt.x && b.max.y > hipsAt.y * 0.6;
  });
  if (blocking) {
    const off = cam.position.clone().sub(lookAt).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(35)).multiplyScalar(1.1);
    // and from a little above, looking down over the desk top at the hands and face.
    off.y += s.y * 0.45;
    cam.position.copy(lookAt).add(off); cam.lookAt(lookAt);
  }
  // A moving camera: the whole move pulls back until the body's whole routine stays in frame, inside the set's limits.
  let pull = 1, shotLength = 1;
  const moving = camera && framing === 'full';
  const setCamera = (t) => {
    const w = viewFor(moveAt(camera, t), restHeight, { pull, limits });
    cam.fov = w.fov; cam.updateProjectionMatrix();
    cam.position.set(w.x, w.y, w.z); cam.lookAt(0, w.lookY, 0);
    return w.yaw;
  };
  if (moving) {
    const corners = []; for (const x of [box.min.x, box.max.x]) for (const y of [0, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push([x, y, z]);
    pull = pullFor(camera, restHeight, corners, width / height, { limits });
  }
  const hides = (set?.hide || []).map(h => ({ range: h.when_camera_deg, nodes: (h.nodes || []).map(n => setRoot.getObjectByName(n)).filter(Boolean) }));
  const showSet = (yaw) => { for (const o of new Set(hides.flatMap(h => h.nodes))) o.visible = !hides.some(h => h.nodes.includes(o) && hiddenAt(h.range, yaw + facing)); }; // hide ranges are in the set's own yaw
  if (set && !moving) showSet(THREE.MathUtils.radToDeg(Math.atan2(cam.position.x, cam.position.z)));
  window.shot = (frames) => { shotLength = Math.max(1, frames - 1); };
  // Settle the hair at the first pose, then play.
  mixer.setTime(0);
  for (let i = 0; i < 90; i++) vrm.update(1 / 60);
  action.reset().play(); mixer.setTime(0);
  // A voice-over moves the mouth: "aa" opens with the voice's loudness in each frame (2026-11-11).
  const em = vrm.expressionManager;
  const canTalk = !!(mouth && em && em.getExpression && em.getExpression('aa'));
  // A rig whose mouth opens by its jaw bone (Character Creator models): the bone moves with the voice too.
  const jaw = canTalk ? jawDriver(vrm) : null;
  window.frame = (i) => {
    if (i > 0) mixer.update(1 / fps);
    updateProps(placed, action.time, i > 0 ? 1 / fps : 0); // the store's show windows and the props' own animations
    // With a jaw bone doing the opening, the skin shape only follows lightly (both at full push the tongue out).
    if (canTalk) { em.setValue('aa', (mouth[i] || 0) * (jaw ? 0.4 : 1)); jaw?.set(mouth[i] || 0); }
    vrm.update(1 / fps);
    worn.apply(vrm); // the look's shape keys, again after the expressions
    if (moving) { const yaw = setCamera(i / shotLength); if (set) showSet(yaw); }
    r.render(scene, cam);
    return r.domElement.toDataURL('image/jpeg', 0.9);
  };
  return { duration: clip.duration, tracks: clip.tracks.length, pole: poleX, talks: canTalk, framing, pull, restHeight, camera: moving ? camera.id : null, set: !!set, props: placed.map(o => o.name), look: { colors: worn.colors, morphs: worn.morphs, hidden: worn.hidden } };
};
window.ready = true;
</script></body></html>`;
}

const VOICE_MAX_S = 60;

/**
 * The voice's length and, per video frame, how open the mouth is (0..1): the loudness of that frame's slice of the
 * audio, scaled to the loudest, with quiet slices shut. ffmpeg decodes any format to 16 kHz mono.
 */
export async function voiceEnvelope(file, fps) {
  const pcm = await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let err = '';
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg could not read the voice: ${err.trim() || code}`))));
  });
  return envelopeFromPcm(pcm, 16000, fps);
}

/** envelope of 16-bit mono PCM: { seconds, mouth[] } (exported for tests). */
export function envelopeFromPcm(pcm, rate, fps) {
  const samples = Math.floor(pcm.length / 2);
  const per = Math.max(1, Math.round(rate / fps));
  const rms = [];
  for (let i = 0; i < samples; i += per) {
    let sum = 0; const end = Math.min(samples, i + per);
    for (let j = i; j < end; j++) { const v = pcm.readInt16LE(j * 2) / 32768; sum += v * v; }
    rms.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  const peak = Math.max(1e-6, ...rms);
  const mouth = rms.map(v => { const x = v / peak; return x < 0.12 ? 0 : Math.min(1, +(x * 1.15).toFixed(3)); });
  return { seconds: samples / rate, mouth };
}

const MIME = { '.js': 'text/javascript', '.vrm': 'model/gltf-binary', '.vrma': 'model/gltf-binary', '.glb': 'model/gltf-binary', '.html': 'text/html', '.jpg': 'image/jpeg' };

/**
 * The model file over a local HTTP server, streamed. Puppeteer's request interception cannot answer with a large body
 * (a 157 MB linked avatar failed with "RangeError: Invalid array length", 2026-11-20): every model goes this way.
 * Returns { url, close }. Listens on 127.0.0.1 only, on a random port and a random path.
 */
async function serveModel(file) {
  const http = await import('node:http');
  const { createReadStream } = await import('node:fs');
  const secret = `/m-${Math.random().toString(36).slice(2)}.vrm`;
  const server = http.createServer((req, res) => {
    if (req.url !== secret) { res.writeHead(404); return res.end(); }
    fs.stat(file).then((st) => {
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': st.size, 'Access-Control-Allow-Origin': '*' });
      createReadStream(file).pipe(res);
    }).catch(() => { res.writeHead(404); res.end(); });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { url: `${origin}${secret}`, origin, path: secret,
    // Chrome keeps its connection open, and close() waits for it: every video and portrait came about 55 s late (2026-11-23).
    close: () => new Promise((ok) => { server.close(() => ok()); server.closeAllConnections?.(); }) };
}
/** A set with no move asked: the body held in front view, sized for a room. */
const FRONT = { format: 'bnb-camera/1', id: 'front', keys: [{ t: 0, yaw: 0, height: 0.62, distance: 2.8, look: 0.55, fov: 30 }] };

let busy = Promise.resolve();

/**
 * Render `clipPath` played by the model at `modelPath`: an H.264 MP4 Buffer, plus its facts.
 * One render at a time; a second waits for the first.
 */
export function renderClipVideo(opts) {
  const run = busy.then(() => render(opts));
  busy = run.catch(() => {});
  return run;
}

async function render({ modelPath, clipPath, loop = false, prop = null, props = null, seconds = null, fps = 24, width = 720, height = 960,
  background = '#121826', backgroundPath = null, framing = 'full', timeoutMs = 8 * 60 * 1000, launch = null, voice = null, look = null, camera = null, setPath = null, setSpec = null } = {}) {
  const started = Date.now();
  const html = pageHtml(designerMethods(await fs.readFile(path.join(PUBLIC_DIR, 'avatar.html'), 'utf8')));
  const { default: puppeteer } = await import('puppeteer');
  const browser = await (launch || ((o) => puppeteer.launch(o)))({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${width},${height}`]
  });
  // Props by absolute path ({ ..., path }): the page asks for /prop/<n>.glb, never a path of its own choosing.
  const propList = (Array.isArray(props) ? props : []).filter(p => p && typeof p.path === 'string');
  const propFiles = propList.map(p => p.path);
  const pageProps = propList.map((p, i) => ({ prop: p.prop, bone: p.bone, position: p.position, rotation: p.rotation, scale: p.scale, scale_with: p.scale_with, ref_hips: p.ref_hips, url: `/prop/${i}.glb` }));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-video-'));
  const out = path.join(tmp, 'clip.mp4');
  // A voice-over: the audio as a file for ffmpeg, its length, and how open the mouth is in each frame.
  let audioFile = null, said = null;
  if (voice?.audio?.length) {
    audioFile = path.join(tmp, `voice.${voice.format || 'mp3'}`);
    await fs.writeFile(audioFile, voice.audio);
    said = await voiceEnvelope(audioFile, fps);
  }
  const timer = setTimeout(() => browser.close().catch(() => {}), timeoutMs);
  const model = await serveModel(modelPath);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      const u = new URL(req.url());
      // The page is on the model server's own origin (same-origin: Chrome blocks a page reaching loopback from elsewhere);
      // the model streams from it, everything else is answered here.
      if (u.origin !== model.origin) return req.abort();
      if (u.pathname === model.path) return req.continue();
      try {
        let body;
        if (u.pathname === '/render.html') body = Buffer.from(html);
        else if (u.pathname === '/clip.vrma') body = await fs.readFile(clipPath);
        else if ((u.pathname === '/set.glb' || u.pathname === '/set.img') && setPath) body = await fs.readFile(setPath);
        else if (u.pathname === '/background.jpg' && backgroundPath) body = await fs.readFile(backgroundPath);
        else if (/^\/prop\/\d+\.glb$/.test(u.pathname) && propFiles[Number(u.pathname.slice(6, -4))]) body = await fs.readFile(propFiles[Number(u.pathname.slice(6, -4))]);
        else if (u.pathname.startsWith('/lib/')) {
          const file = path.join(PUBLIC_DIR, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
          if (!file.startsWith(path.join(PUBLIC_DIR, 'lib'))) return req.respond({ status: 404, body: '' });
          body = await fs.readFile(file);
        } else return req.respond({ status: 404, body: '' });
        req.respond({ status: 200, contentType: MIME[path.extname(u.pathname)] || 'application/octet-stream', body });
      } catch { req.respond({ status: 404, body: '' }); }
    });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(`${model.origin}/render.html`, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate((u) => { window.MODEL_URL = u; }, model.url);
    await page.waitForFunction('window.ready === true', { timeout: 60000 }).catch(() => { throw new Error(`the render page did not start: ${pageErrors[0] || 'no error given'}`); });
    // The clip's length is known only once it is loaded, so the page is set up with a generous span first.
    const probe = await page.evaluate((o) => window.setup(o), { width, height, fps, seconds: 40, loop, prop, props: pageProps, background, backgroundImage: !!backgroundPath, framing: ['waist', 'head'].includes(framing) ? framing : 'full', look,
      camera: camera && !moveProblem(camera) ? camera : setPath && setSpec ? FRONT : null, set: setPath && setSpec ? setSpec : null,
      // The voice starts 0.3 s in, so the mouth does too.
      mouth: said?.mouth ? [...new Array(Math.round(VOICE_LEAD_S * fps)).fill(0), ...said.mouth] : null });
    // With a voice-over the video runs at least as long as the voice (the clip holds its last pose, or loops).
    const total = said ? spokenSeconds(probe.duration, loop, said.seconds) : videoSeconds(probe.duration, loop, { seconds });
    const frames = Math.max(1, Math.round(total * fps));
    await page.evaluate((n) => window.shot(n), frames);
    const audioArgs = audioFile ? ['-itsoffset', String(VOICE_LEAD_S), '-i', audioFile, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '128k'] : [];
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      ...audioArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...(audioFile ? [] : ['-an']), out], { stdio: ['pipe', 'ignore', 'pipe'] });
    let ffErr = '';
    ff.stderr.on('data', (b) => { ffErr += b; });
    const done = new Promise((resolve, reject) => ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${ffErr.trim() || `exit ${code}`}`)))));
    const drawing = Date.now();
    for (let i = 0; i < frames; i++) {
      const url = await page.evaluate((n) => window.frame(n), i);
      if (!ff.stdin.write(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
    }
    const drawMs = Date.now() - drawing;
    ff.stdin.end();
    await done;
    const video = await fs.readFile(out);
    const facts = { seconds: +(frames / fps).toFixed(2), frames, fps, width, height, bytes: video.length, pole: probe.pole, props: probe.props || [], ms: Date.now() - started, frameMs: +(drawMs / frames).toFixed(1), camera: probe.camera || null, pull: +probe.pull.toFixed(2), set: !!probe.set, voice: !!said, lipSync: !!probe.talks };
    if (pageProps.length && facts.props.length < pageProps.length) logger.warn(`Clip video: ${facts.props.length} of ${pageProps.length} props shown on ${path.basename(clipPath)}`);
    logger.info(`Clip video: ${path.basename(clipPath)} on ${path.basename(modelPath)}${facts.props.length ? ` with ${facts.props.join(', ')}` : ''}, ${facts.seconds}s, ${frames} frames, ${(video.length / 1048576).toFixed(1)} MB in ${(facts.ms / 1000).toFixed(0)}s`);
    return { video, ...facts };
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
    await model.close().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A head-and-shoulders portrait of a model, rendered here (the same three.js and three-vrm as the videos): arms down,
 * facing the camera with a light smile, the owner's saved look on (linked avatars). For a model that came without a
 * picture (a linked avatar from the owner's own store account), so the profile pictures can follow the body.
 * Returns a square PNG buffer.
 */
export function renderPortrait(opts) {
  const run = busy.then(() => portrait(opts));
  busy = run.catch(() => {});
  return run;
}

const PORTRAIT_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head><body>
<script src="/lib/three.r183.min.js"></script>
<script type="importmap">{ "imports": { "three": "/lib/three.r183.module.js", "three/addons/": "/lib/addons/" } }</script>
<script type="module">
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as V from '/lib/three-vrm.module.js';
import { wearLook } from '/lib/vrm-look.js';
const THREE = window.THREE;
window.portrait = async ({ size, background, look }) => {
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1); r.setSize(size, size); r.outputColorSpace = THREE.SRGBColorSpace; document.body.appendChild(r.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4050, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(0.8, 2.2, 2.5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc4ff, 1.0); rim.position.set(-2, 2, -2); scene.add(rim);
  const l = new GLTFLoader(); l.register(p => new V.VRMLoaderPlugin(p));
  const vrm = (await l.loadAsync(window.MODEL_URL || '/model.vrm')).userData.vrm;
  if (V.VRMUtils?.rotateVRM0) V.VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  scene.add(vrm.scene);
  const worn = wearLook(vrm, look);
  // Arms down (out of the T-pose) and a light smile.
  const bone = (n) => vrm.humanoid?.getNormalizedBoneNode(n);
  if (bone('leftUpperArm')) bone('leftUpperArm').rotation.z = -1.2;
  if (bone('rightUpperArm')) bone('rightUpperArm').rotation.z = 1.2;
  vrm.expressionManager?.setValue('happy', 0.25);
  vrm.update(0); worn.apply(vrm); vrm.scene.updateMatrixWorld(true);
  const p = (n) => vrm.humanoid?.getRawBoneNode(n)?.getWorldPosition(new THREE.Vector3());
  const head = p('head') || new THREE.Vector3(0, 1.5, 0);
  const neck = p('neck') || head.clone().add(new THREE.Vector3(0, -0.1, 0));
  // Frame from the collarbones to just above the head, square.
  const top = head.y + 0.22, bottom = neck.y - 0.1;
  const h = top - bottom, cy = (top + bottom) / 2;
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  const dist = (h / 2) / Math.tan((30 * Math.PI / 180) / 2);
  cam.position.set(head.x, cy, head.z + dist); cam.lookAt(head.x, cy, head.z);
  if (vrm.lookAt) { const t = new THREE.Object3D(); t.position.copy(cam.position); scene.add(t); vrm.lookAt.target = t; }
  vrm.update(0); worn.apply(vrm);
  r.render(scene, cam);
  return r.domElement.toDataURL('image/png');
};
window.ready = true;
</script></body></html>`;

async function portrait({ modelPath, look = null, size = 1024, background = '#1b2333', timeoutMs = 3 * 60 * 1000, launch = null } = {}) {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await (launch || ((o) => puppeteer.launch(o)))({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${size},${size}`]
  });
  const timer = setTimeout(() => browser.close().catch(() => {}), timeoutMs);
  const model = await serveModel(modelPath);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: size, height: size });
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      const u = new URL(req.url());
      // The page is on the model server's own origin (same-origin: Chrome blocks a page reaching loopback from elsewhere);
      // the model streams from it, everything else is answered here.
      if (u.origin !== model.origin) return req.abort();
      if (u.pathname === model.path) return req.continue();
      try {
        let body;
        if (u.pathname === '/portrait.html') body = Buffer.from(PORTRAIT_HTML);
        else if (u.pathname.startsWith('/lib/')) {
          const file = path.join(PUBLIC_DIR, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
          if (!file.startsWith(path.join(PUBLIC_DIR, 'lib'))) return req.respond({ status: 404, body: '' });
          body = await fs.readFile(file);
        } else return req.respond({ status: 404, body: '' });
        req.respond({ status: 200, contentType: MIME[path.extname(u.pathname)] || 'application/octet-stream', body });
      } catch { req.respond({ status: 404, body: '' }); }
    });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(`${model.origin}/portrait.html`, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate((u) => { window.MODEL_URL = u; }, model.url);
    await page.waitForFunction('window.ready === true', { timeout: 60000 }).catch(() => { throw new Error(`the portrait page did not start: ${pageErrors[0] || 'no error given'}`); });
    const url = await page.evaluate((o) => window.portrait(o), { size, background, look });
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
    await model.close().catch(() => {});
  }
}
