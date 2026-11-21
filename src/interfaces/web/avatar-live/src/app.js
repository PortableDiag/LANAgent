// LANAgent's live avatar: AvatarX's page (AvatarX 0.3.19, 3ec549c), served by the agent itself. What differs from AvatarX
// is marked "LANAgent:"; lanagent.js routes the page's calls to /api/avatar-live with the dashboard's login.
import { login, setToken, events, protectedImage, EMBED, EMBED_BACKGROUND, EMBED_LIFT, EMBED_ZOOM } from './lanagent.js';
import { wearLook } from './look.js';  // LANAgent: AvatarX 0.4.6 looks (linked avatars)
import { jawDriver } from './jaw.js';  // LANAgent: jaw-bone mouths (Character Creator models)
// The page: login, the avatar on stage, chat, talk, settings. The agent's changes arrive on
// /api/events; a model's own expressions are read at load, since they differ from one to the next.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { Motion, forgetClip, GESTURES } from './motion.js';
import { VR } from './vr.js';

const $ = (id) => document.getElementById(id);
// Render mode: the server's own headless browser making a video of one move (render.rs).
// LANAgent: videos are made by the agent's own renderer (services/avatar/clipVideo.js), never by this page.
const RENDER = null;
if (EMBED) document.body.classList.add('embed');

// Problems reach the server's log so they can be read later: at most 20 a page load, and never what anyone said.
let reported = 0;
function report(kind, note) {
  if (reported++ >= 20) return;
  fetch('/api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, note: String(note || '').slice(0, 200) }) }).catch(() => {});
}
window.__report = report;
addEventListener('error', (e) => report('script_error', `${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => report('promise_error', e.reason?.message || 'rejected'));
let state = null;
let status = null;

// --- server calls --------------------------------------------------------
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const v = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login' && path !== '/api/password') { showGate(); }
  if (!r.ok) { const e = new Error(v.error || `${r.status}`); e.status = r.status; e.retry = v.retry_after; throw e; }
  return v;
}

// --- login ---------------------------------------------------------------
function showGate() {
  $('app').hidden = true;
  $('gate').hidden = false;
  const first = status && !status.has_password;
  // LANAgent: the dashboard's own password; the page has none of its own.
  if (EMBED) { window.__avatar = { ready: false, error: 'not signed in' }; return; }
  $('gate-title').textContent = status ? status.agent : 'LANAgent';
  $('gate-help').textContent = 'Sign in with the dashboard password.';
  $('gate-go').textContent = first ? 'Set password' : 'Log in';
  $('gate-go').disabled = first && !status.can_setup;
  $('gate-pw').autocomplete = first ? 'new-password' : 'current-password';
  $('gate-pw').focus();
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('gate-err').textContent = '';
  $('gate-go').disabled = true;
  try {
    await login($('gate-pw').value);
    $('gate-pw').value = '';
    await start();
  } catch (err) {
    $('gate-err').textContent = err.message;
  } finally {
    $('gate-go').disabled = false;
  }
});

// --- the stage -----------------------------------------------------------
const canvas = $('stage');
// Render mode draws without antialiasing: a software renderer on a small server pays dearly for it.
// LANAgent: in the app's embed the stage is see-through, so the app's own screen shows behind the body.
const SEE_THROUGH = EMBED && !EMBED_BACKGROUND;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !RENDER, alpha: SEE_THROUGH, preserveDrawingBuffer: !!RENDER });
if (SEE_THROUGH) renderer.setClearColor(0x000000, 0);
renderer.xr.enabled = true;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 100);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.0));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(1, 2, 2);
scene.add(key);
// Drag to walk the camera round the avatar, pinch or wheel to come closer, double-tap for the front
// again. The avatar stays where it stands; the view is the owner's.
const controls = RENDER ? null : new OrbitControls(camera, canvas);
let orbited = false;
if (controls) {
  Object.assign(controls, { enablePan: false, enableDamping: true, dampingFactor: 0.12, rotateSpeed: 0.7,
    minDistance: 0.4, maxDistance: 8, minPolarAngle: 0.15, maxPolarAngle: Math.PI * 0.62 });
  controls.addEventListener('start', () => { orbited = true; });
  canvas.addEventListener('dblclick', () => { orbited = false; placeCamera(); });
  window.__cam = () => ({ at: camera.position.toArray().map((x) => +x.toFixed(3)), orbited });
}
const lookTarget = new THREE.Object3D();
scene.add(lookTarget);
const BACKGROUNDS = { nebula: 0x0b1020, dusk: 0x2a1a3a, studio: 0x8a93a3, black: 0x000000 };

let vrm = null;
let motion = null;
let vrmId = null;
let loading = 0;
let framing = { y: 1.3, dist: 2.2 };
const presets = new Set();
const pointer = new THREE.Vector2(0, 0);
let moodHold = null;
let lastSpoke = -1e9;  // when the agent's voice was last heard (the talk loop follows it)
window.__speakFor = (secs) => { lastSpoke = performance.now() + secs * 1000 - 1200; };  // tests: as if speaking
let mouthLevel = 0;     // 0..1, from audio or from text arriving
let textMouthUntil = 0;
let lastFrame = performance.now();
let fixedDt = 0;
let skipDraw = false;  // render mode: settling steps move the body without drawing it  // render mode: a fixed step, so a slow machine still makes smooth video
let elapsed = 0;
let nextBlink = 2;
let frames = 0;
let thinking = false;
let vr = null;
let blinkT = -1;

// An uploaded background picture fills the view like CSS cover: cropped, never stretched.
const bg = { name: '', tex: null, ready: Promise.resolve() };
let renderJob = null;
const bgLoader = new THREE.TextureLoader();
function coverBackground() {
  const t = bg.tex;
  if (!t || !t.image || !t.image.width) return;
  const view = renderer.domElement.width / Math.max(1, renderer.domElement.height);
  const pic = t.image.width / t.image.height;
  if (view > pic) { t.repeat.set(1, pic / view); t.offset.set(0, (1 - pic / view) / 2); }
  else { t.repeat.set(view / pic, 1); t.offset.set((1 - view / pic) / 2, 0); }
}
function setBackground(name) {
  // A video can ask for its own background; the page's setting stays as it is.
  if (RENDER && renderJob?.background) name = renderJob.background;
  if (SEE_THROUGH) { scene.background = null; bg.ready = Promise.resolve(); return; }
  if (!(state.custom_backgrounds || []).includes(name)) {
    bg.name = '';
    scene.background = new THREE.Color(BACKGROUNDS[name] ?? BACKGROUNDS.nebula);
    bg.ready = Promise.resolve();
    return;
  }
  if (bg.name === name) { if (bg.tex) scene.background = bg.tex; return; }
  bg.name = name;
  bg.ready = new Promise((done) => {
    // LANAgent: the picture is behind the login, so it is fetched with it first.
    protectedImage(`/api/backgrounds/${encodeURIComponent(name)}/file`).then((src) => bgLoader.load(src, (t) => {
      URL.revokeObjectURL(src);
      if (bg.name !== name) { t.dispose(); done(); return; }
      t.colorSpace = THREE.SRGBColorSpace;
      bg.tex?.dispose();
      bg.tex = t;
      scene.background = t;
      coverBackground();
      done();
    }, undefined, () => { report('background', name); done(); })).catch(() => { report('background', name); done(); });
  });
}

function resize() {
  if (RENDER) return;
  renderer.setSize(innerWidth, innerHeight, false);
  coverBackground();
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  // A keyboard opening resizes the page: keep a view the owner chose.
  if (orbited) setViewOffset(); else placeCamera();
}
addEventListener('resize', resize);
let lastPointer = -1e9;
addEventListener('pointermove', (e) => { lastPointer = performance.now(); pointer.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1)); });

function placeCamera() {
  if (renderer.xr.isPresenting) return;
  const zoom = EMBED_ZOOM >= 0.5 ? EMBED_ZOOM : state && !RENDER ? state.zoom : 1;
  const narrow = camera.aspect < 0.8 && !RENDER ? 1.25 : 1;
  // Zooming in aims at the face, so it never crops the head.
  const y = framing.y + (framing.face ? (framing.face - framing.y) * Math.min(1, Math.max(0, zoom - 1)) : 0);
  camera.position.set(0, y, (framing.dist * narrow) / zoom);
  camera.lookAt(0, y, 0);
  if (controls) { controls.target.set(0, y, 0); controls.update(); }
  setViewOffset();
}

// The chat sits on the right on a wide screen, so the model stands left of centre.
function setViewOffset() {
  // LANAgent: the app's chat covers the lower part of an embedded stage, so the body is drawn higher.
  if (EMBED && EMBED_LIFT) { camera.setViewOffset(innerWidth, innerHeight, 0, innerHeight * EMBED_LIFT, innerWidth, innerHeight); return; }
  if (camera.aspect > 1.2 && !RENDER && !EMBED) camera.setViewOffset(innerWidth, innerHeight, innerWidth * 0.14, 0, innerWidth, innerHeight);
  else camera.clearViewOffset();
}

let wornLook = null;
let jaw = null;
let wornLookKey = 'null';
async function loadAvatar(id) {
  if (id === vrmId) return;
  vrmId = id;
  const ticket = ++loading;
  if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); vrm = null; motion = null; }
  $('empty').hidden = !!id;
  $('load-note').hidden = true;
  presets.clear();
  window.__avatar = { ready: false };
  if (!id) return;
  $('load-note').hidden = false;
  $('load-note').textContent = 'Loading the avatar…';
  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p));
  try {
    const gltf = await loader.loadAsync(`/api/avatars/${id}/file`, (ev) => {
      if (ticket === loading && ev.total) $('load-note').textContent = `Loading the avatar… ${Math.round(ev.loaded / ev.total * 100)}%`;
    });
    if (ticket !== loading) { VRMUtils.deepDispose(gltf.scene); return; }
    const v = gltf.userData.vrm;
    if (!v) throw new Error('this file has no VRM data');
    // No VRMUtils.combineSkeletons here: on models with several skins it binds the hair wrong, and
    // the hair flies up and sideways (2026-11-05, BotsAndBorgs models, physics off or on). It only saves a little.
    VRMUtils.rotateVRM0(v);
    v.scene.traverse((o) => { o.frustumCulled = false; });
    scene.add(v.scene);
    vrm = v;
    // LANAgent: a linked body wears the owner's saved look (AvatarX 0.4.6): pieces, colours, shape keys.
    const look = state?.avatars?.find((a) => a.id === id)?.look ?? null;
    wornLookKey = JSON.stringify(look);
    wornLook = wearLook(v, look);
    jaw = jawDriver(v);
    motion?.props?.dispose();
    motion = new Motion(v);
    motion.props.sync(state?.props);
    pickIdle();
    motion.thinkingOn = thinking;
    if (v.lookAt) v.lookAt.target = lookTarget;
    for (const name of Object.keys(v.expressionManager?.expressionMap || {})) presets.add(name);
    motion.update(0, 0, { x: 0, y: 0 });
    v.scene.updateMatrixWorld(true);
    v.update(0);
    v.springBoneManager?.setInitState();
    v.springBoneManager?.reset();
    frameModel();
    applyMood();
    $('load-note').hidden = true;
    window.__avatar = { ready: true, id, presets: [...presets], lookAt: !!v.lookAt, look: { colors: wornLook.colors, morphs: wornLook.morphs, pieces: wornLook.pieces, hidden: wornLook.hidden } };

  } catch (err) {
    if (ticket !== loading) return;
    $('load-note').textContent = `That avatar did not load: ${err.message}`;
    report('avatar_load_failed', err.message);
    window.__avatar = { ready: false, error: err.message };
  }
}

function frameModel() {
  vrm.scene.updateMatrixWorld(true);
  const head = vrm.humanoid?.getNormalizedBoneNode('head');
  // The body alone: the pole (a child of the model, hidden) must not count, or it frames 3 m of nothing.
  const box = new THREE.Box3();
  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (let a = o; a; a = a.parent) if (a.userData?.notBody) return;
    box.expandByObject(o);
  });
  const size = box.getSize(new THREE.Vector3());
  const top = box.max.y;
  if (head) {
    const p = head.getWorldPosition(new THREE.Vector3());
    // Chest up, the head in the upper part of the frame. The zoom setting takes it from there.
    framing = { y: p.y - size.y * 0.14, dist: Math.max(size.y * 1.25, 1.1), face: p.y };
  } else {
    framing = { y: box.min.y + size.y * 0.55, dist: Math.max(size.y, size.x) * 3.0 };
  }
  framing.top = top;
  if (RENDER) {
    // A video: the whole body, with room for arms up and steps aside; or waist up, or head and shoulders.
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const how = renderJob?.framing || 'full';
    const hips = vrm.humanoid?.getNormalizedBoneNode('hips')?.getWorldPosition(new THREE.Vector3());
    const headY = head ? head.getWorldPosition(new THREE.Vector3()).y : top - size.y * 0.1;
    let bottom = box.min.y, pad = 1.22;
    if (how === 'waist') { bottom = (hips ? hips.y : box.min.y + size.y * 0.5) - size.y * 0.06; pad = 1.18; }
    if (how === 'head') { bottom = headY - (top - headY) * 1.9; pad = 1.25; }
    const h = top - bottom;
    framing = { y: bottom + h * 0.5, dist: (h * pad) / 2 / tan, top };
  }
  placeCamera();
}

function applyMood() {
  if (!vrm?.expressionManager || !state) return;
  for (const m of state.moods) if (m !== 'neutral' && presets.has(m)) vrm.expressionManager.setValue(m, 0);
  const m = moodHold ? moodHold.name : state.mood;
  if (m !== 'neutral' && presets.has(m)) vrm.expressionManager.setValue(m, 0.8);
}

function animate() {
  const now = performance.now();
  const dt = fixedDt || Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  elapsed += dt;
  const t = elapsed;
  frames++;
  const head = vr?.update(dt) || null;
  if (vrm) {
    // Looking: at the headset in VR, else at the pointer, or idly about.
    const lookOn = state?.look_at_you !== false;
    let look;
    if (head) {
      const faced = vrm.humanoid?.getNormalizedBoneNode('head')?.getWorldPosition(new THREE.Vector3());
      lookTarget.position.copy(head);
      const d = faced ? head.clone().sub(faced) : new THREE.Vector3(0, 0, 1);
      look = { x: Math.atan2(d.x, d.z) * 1.6, y: Math.atan2(d.y, Math.hypot(d.x, d.z)) * 2 };
    } else {
      // Follow the pointer while it moves, gently, then settle back to looking ahead.
      const fresh = THREE.MathUtils.clamp(1 - (now - lastPointer - 2500) / 1500, 0, 1);
      look = lookOn ? { x: pointer.x * 0.7 * fresh, y: pointer.y * 0.35 * fresh } : { x: 0, y: 0 };
      // Wherever the camera has been walked to: the head turns that way too, unless it is behind.
      const faced = vrm.humanoid?.getNormalizedBoneNode('head')?.getWorldPosition(new THREE.Vector3());
      if (lookOn && faced) {
        const d = camera.position.clone().sub(faced);
        const side = Math.atan2(d.x, d.z);
        if (Math.abs(side) < 1.2) look = { x: look.x + side * 1.6, y: look.y };
      }
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      lookTarget.position.copy(camera.position).addScaledVector(right, look.x * 0.5);
      lookTarget.position.y += look.y;
    }
    const em = vrm.expressionManager;
    // The voice's level, or a soft flutter while text arrives without speech.
    let level = voiceLevel();
    // Talking (the agent's voice heard, or a typed reply being spoken): the talk loop plays.
    if (level > 0.03 || (speech.playing && !$('speech').paused)) lastSpoke = now;
    motion.talking = now - lastSpoke < 1200;
    if (level === 0 && performance.now() < textMouthUntil) level = 0.25 + 0.2 * Math.abs(Math.sin(t * 11));
    mouthLevel += (level - mouthLevel) * Math.min(1, dt * 18);
    motion.thinkingOn = thinking;
    motion.update(dt, mouthLevel, look);
    if (em) {
      if (presets.has('blink')) {
        nextBlink -= dt;
        if (nextBlink <= 0 && blinkT < 0) { blinkT = 0; nextBlink = 2.5 + Math.random() * 4; }
        let b = 0;
        if (blinkT >= 0) { blinkT += dt; b = blinkT < 0.07 ? blinkT / 0.07 : Math.max(0, 1 - (blinkT - 0.07) / 0.1); if (blinkT > 0.17) blinkT = -1; }
        em.setValue('blink', b);
      }
      // LANAgent: a jaw-bone mouth opens with the voice; the skin shape then follows lightly (both at full push the tongue out).
      if (presets.has('aa')) em.setValue('aa', Math.min(1, mouthLevel * 1.1) * (jaw ? 0.4 : 1));
      jaw?.set(Math.min(1, mouthLevel * 1.1));
      if (presets.has('ou')) em.setValue('ou', Math.min(0.6, mouthLevel * 0.5 * (0.5 + 0.5 * Math.sin(t * 7))));
      if (presets.has('ih')) em.setValue('ih', Math.min(0.5, mouthLevel * 0.4 * (0.5 + 0.5 * Math.sin(t * 5 + 1))));
    }
    window.__mouthPeak = Math.max(window.__mouthPeak || 0, mouthLevel);
    if (moodHold && performance.now() > moodHold.until) { moodHold = null; applyMood(); }
    // A dance's eyes go with its head: eyes held on the camera while the body turns look wrong
    // (the head already stops following during a clip). They ease back to you when it ends.
    const la = vrm.lookAt;
    if (la) {
      const dancing = !!motion?.clip && !head;
      la.autoUpdate = !dancing;
      if (dancing) {
        const k = 1 - Math.min(1, dt * 6);
        la.yaw *= k;
        la.pitch *= k;
      }
    }
    vrm.update(dt);
    wornLook?.apply(vrm);  // LANAgent: the look's shape keys, again after the expressions
  }
  if (controls && !renderer.xr.isPresenting) controls.update();
  if (!skipDraw) renderer.render(scene, camera);
}

// --- state and settings --------------------------------------------------
function applyState() {
  setBackground(state.background);
  $('zoom').value = state.zoom;
  $('look').checked = state.look_at_you;
  $('speak').checked = state.speak_replies;
  fillGestures();
  motion?.props.sync(state.props);
  pickIdle();
  fillVoices();
  fill($('background'), state.backgrounds, state.background);
  fill($('mood'), state.moods, state.mood);
  const ul = $('avatars');
  ul.replaceChildren(...state.avatars.map((a) => {
    const li = document.createElement('li');
    li.className = a.id === state.active ? 'active' : '';
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = a.name;
    const small = document.createElement('small');
    small.textContent = `${(a.size / 1048576).toFixed(1)} MB${a.id === state.active ? ' · showing' : ''}`;
    what.append(small);
    li.append(what);
    if (a.id !== state.active) li.append(button('Show', () => patch({ active: a.id })));
    // LANAgent: only an uploaded body can go here; the designer manages the gallery's.
    li.append(button('Delete', async () => { try { await api('DELETE', `/api/avatars/${a.id}`); } catch (err) { $('upload-note').textContent = err.message; } }));
    return li;
  }));
  $('empty').hidden = !!state.active;
  placeCamera();
  // LANAgent: the owner changed the look the shown body wears: put it on again with the new one.
  if (vrm && state.active === vrmId && JSON.stringify(state.avatars?.find((a) => a.id === vrmId)?.look ?? null) !== wornLookKey) vrmId = null;
  loadAvatar(state.active);
  applyMood();
}
function fillVoices() {
  const sel = $('voice-pick');
  sel.replaceChildren(...[{ name: '', sounds: '' }, ...state.voices].map((v) => {
    const o = document.createElement('option');
    o.value = v.name; o.textContent = v.name ? `${v.name} (${v.sounds})` : 'Choose a voice';
    return o;
  }));
  sel.value = state.voice;
  // LANAgent: the agent always speaks in its own set voice (changed in its voice settings, not per body).
  sel.disabled = true;
  $('voice-note').textContent = 'The agent keeps its own voice for every body, its videos and its calls.';
}
const VROID = [1, 2, 3, 4, 5, 6, 7].map((i) => `https://hub.vroid.com/public/animations/VRMA_0${i}.vrma`);
function fillVroidLinks() {
  $('vroid-links').replaceChildren('Free motions from VRoid Hub (© pixiv Inc.), to download and add here: ', ...VROID.flatMap((u, i) => {
    const a = document.createElement('a');
    a.href = u; a.textContent = String(i + 1); a.target = '_blank'; a.rel = 'noopener';
    return i ? [' ', a] : [a];
  }));
}
function fillIdlePick() {
  const sel = $('idle-pick');
  sel.replaceChildren(...['', ...state.animations].map((n) => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n ? n.replace(/_/g, ' ') : 'Casual standing (built in)';
    return o;
  }));
  sel.value = state.idle || '';
}
function fillGestures() {
  fillIdlePick();
  const names = [...state.gestures, ...state.animations];
  if ($('gestures').dataset.names === names.join()) return;
  $('gestures').dataset.names = names.join();
  $('gestures').replaceChildren(...names.map((n) => button(n.replace(/_/g, ' '), () => api('POST', '/api/gesture', { name: n }))));
  $('clips').replaceChildren(...state.animations.map((n) => {
    const li = document.createElement('li');
    const what = document.createElement('span');
    what.className = 'what'; what.textContent = n;
    li.append(what, button('Delete', () => api('DELETE', `/api/animations/${encodeURIComponent(n)}`).catch((err) => { $('clip-note').textContent = err.message; })));
    return li;
  }));
}
// The idle clip the owner picked, if any. The built-in casual stance is the default.
// The talk loop the agent owns, if any: a clip named talk-loop (or ending in -talk-loop).
function pickTalk() {
  if (!motion) return;
  const names = state?.animations || [];
  const name = names.find((n) => n === 'talk-loop') || names.find((n) => n.endsWith('-talk-loop')) || '';
  if (motion.talkName === name) return;
  motion.useTalk(name).catch((err) => report('motion_failed', `talk loop ${name}: ${err.message}`));
}
function pickIdle() {
  pickTalk();
  if (!motion || motion.idleName === (state?.idle || '')) return;
  motion.useIdle(state?.idle || '').catch((err) => addMsg('error', `That idle did not play: ${err.message}`));
}
function playGesture(name) {
  window.__lastGesture = name;
  if (!motion) return;
  if (motion.play(name)) return;
  motion.playClip(name).catch((err) => { report('motion_failed', `${name}: ${err.message}`); addMsg('error', `That motion did not play: ${err.message}`); });
}
function fill(sel, items, value) {
  sel.replaceChildren(...items.map((x) => { const o = document.createElement('option'); o.value = x; o.textContent = x; return o; }));
  sel.value = value;
}
function button(label, fn) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; b.addEventListener('click', fn);
  return b;
}
async function refresh() { state = await api('GET', '/api/state'); applyState(); }
async function patch(p) { state = await api('PATCH', '/api/state', p); applyState(); }

$('open-settings').addEventListener('click', () => { $('settings').hidden = false; loadSessions(); });
$('close-settings').addEventListener('click', () => { $('settings').hidden = true; });
$('zoom').addEventListener('input', () => { state.zoom = +$('zoom').value; placeCamera(); });
$('zoom').addEventListener('change', () => patch({ zoom: +$('zoom').value }));
$('background').addEventListener('change', () => patch({ background: $('background').value }));
$('mood').addEventListener('change', () => patch({ mood: $('mood').value }));
$('look').addEventListener('change', () => patch({ look_at_you: $('look').checked }));
$('idle-pick').addEventListener('change', () => patch({ idle: $('idle-pick').value }));
$('voice-pick').addEventListener('change', () => { if ($('voice-pick').value) { speech.errored = false; patch({ voice: $('voice-pick').value }); } });
$('speak').addEventListener('change', () => { if (!$('speak').checked) stopSpeech(); patch({ speak_replies: $('speak').checked }); });
// Your own motions: a .vrma, an .fbx, or a .zip with any number of them. A zip is opened here, so the
// server only ever sees the clips themselves and checks each one.
$('upload-clip').addEventListener('change', async () => {
  const files = [...$('upload-clip').files];
  $('upload-clip').value = '';
  const send = async (name, body) => {
    const r = await fetch(`/api/animations?name=${encodeURIComponent(name)}`, { method: 'POST', body });
    const v = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(v.error || `${r.status}`);
    forgetClip(v.animation);
    return v.animation;
  };
  const added = [];
  const note = $('clip-note');
  try {
    for (const f of files) {
      note.textContent = `Adding ${f.name}…`;
      if (/\.zip$/i.test(f.name)) {
        const parts = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: (x) => /\.(vrma|fbx)$/i.test(x.name) && !/(^|\/)__MACOSX\//.test(x.name) && x.originalSize <= 64 * 1048576 });
        const names = Object.keys(parts);
        if (!names.length) throw new Error(`${f.name} has no .vrma or .fbx in it`);
        for (const n of names) added.push(await send(n.split('/').pop(), parts[n]));
      } else added.push(await send(f.name, f));
    }
    note.textContent = added.length ? `Added: ${added.join(', ')}. Tap one above to play it.` : '';
    window.__clipsAdded = added;
  } catch (err) { note.textContent = err.message; }
});

$('new-chat').addEventListener('click', async () => { await api('DELETE', '/api/chat'); $('log').replaceChildren(); $('settings').hidden = true; });
// LANAgent: signing out is the dashboard's: the token goes. Logins and the password are managed in the dashboard.
$('logout').addEventListener('click', () => { setToken(''); location.reload(); });
$('upload').addEventListener('change', async () => {
  const f = $('upload').files[0];
  if (!f) return;
  $('upload-note').textContent = `Uploading ${f.name}…`;
  try {
    const name = encodeURIComponent(f.name);
    const r = await fetch(`/api/avatars?name=${name}`, { method: 'POST', body: f });
    const v = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(v.error || `${r.status}`);
    await patch({ active: v.avatar.id });
    $('upload-note').textContent = '';
  } catch (err) { $('upload-note').textContent = err.message; }
  $('upload').value = '';
});
async function loadSessions() {}  // LANAgent: no page logins of its own

// --- what the agent changes, as it happens --------------------------------
function connectEvents() {
  // LANAgent: fetch-based events, so the login header goes along (lanagent.js).
  events({ onopen: () => { $('link').className = 'up'; }, onerror: () => { $('link').className = 'down'; }, onmessage: (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'state') refresh();
    if (e.type === 'expression') {
      moodHold = { name: e.name, until: performance.now() + e.seconds * 1000 };
      applyMood();
      window.__lastExpression = e.name;
    }
    if (e.type === 'gesture') playGesture(e.name);
  } });
}

// --- chat ----------------------------------------------------------------
function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  d.textContent = text;
  $('log').append(d);
  $('log').scrollTop = $('log').scrollHeight;
  return d;
}

$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('say').requestSubmit(); }
});
$('text').addEventListener('input', () => { const t = $('text'); t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px`; });

$('say').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = ''; $('text').style.height = 'auto';
  addMsg('user', text);
  stopSpeech();
  speech.buffer = '';
  thinking = true;
  $('send').disabled = true;
  $('busy').hidden = false; $('busy').textContent = `${status.agent} is thinking…`;
  let bubble = null;
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) {
      const v = await r.json().catch(() => ({}));
      if (r.status === 401) showGate();
      throw new Error(v.error || `${r.status}`);
    }
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = ''; let event = ''; let failed = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trimEnd();
        buf = buf.slice(i + 1);
        if (line.startsWith('event: ')) { event = line.slice(7); continue; }
        if (line === '') { event = ''; continue; }
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6);
        if (d === '[DONE]') continue;
        let v; try { v = JSON.parse(d); } catch { continue; }
        if (event === 'hermes.tool.progress') {
          $('busy').textContent = `${status.agent}: ${v.label || v.tool || v.name || 'working'}…`;
          continue;
        }
        const c = v.choices?.[0];
        if (v.error) failed = v.error.message || 'the agent failed';
        if (c?.finish_reason === 'error' || c?.finish_reason === 'cancelled') failed = failed || `the turn ended: ${c.finish_reason}`;
        const piece = c?.delta?.content;
        if (piece) {
          if (!bubble) { bubble = addMsg('assistant', ''); thinking = false; }
          bubble.textContent += piece;
          speakPiece(piece);
          $('log').scrollTop = $('log').scrollHeight;
          textMouthUntil = performance.now() + 500;
        }
      }
    }
    speakFlush();
    if (failed) throw new Error(failed);
    if (!bubble) throw new Error(`${status.agent} sent no answer`);
  } catch (err) {
    addMsg('error', err.message);
  } finally {
    thinking = false;
    $('send').disabled = false;
    $('busy').hidden = true;
    $('text').focus();
  }
});

// --- talk ----------------------------------------------------------------
// A forgotten call keeps costing money: five quiet minutes end it. (window.__voiceIdleMs: tests.)
const VOICE_IDLE_MS = 5 * 60 * 1000;
let lastVoice = 0;
setInterval(() => {
  if (call && performance.now() - lastVoice > (window.__voiceIdleMs || VOICE_IDLE_MS)) stopTalk('Talk ended after five quiet minutes.');
}, 1000);

let call = null;
let analyser = null;
let levels = null;

function levelOf(an, buf) {
  an.getByteTimeDomainData(buf);
  let sum = 0;
  for (const x of buf) { const d = (x - 128) / 128; sum += d * d; }
  return Math.min(1, Math.sqrt(sum / buf.length) * 5);
}
// A video's spoken line drives the mouth frame by frame (renderMain): the page is muted there.
let renderLevel = null;
// LANAgent: the Android app plays the voice itself and hands the page its loudness (window.lanagentAvatar.level).
const external = { level: 0, at: -1e9 };
function voiceLevel() {
  if (renderLevel !== null) return renderLevel;
  let l = performance.now() - external.at < 400 ? external.level : 0;
  if (analyser) l = Math.max(l, levelOf(analyser, levels));
  if (speech.analyser && !$('speech').paused) l = Math.max(l, levelOf(speech.analyser, speech.levels));
  return l;
}

// --- typed replies, spoken -------------------------------------------------
// Sentence by sentence as the text arrives, so speech starts well before the reply ends.
const speech = { buffer: '', queue: [], playing: false, ctx: null, analyser: null, levels: null, ticket: 0, errored: false };
function speakable() {
  // LANAgent: speech is the agent's own TTS (any provider), so it does not hang on the realtime key (status.voice).
  if (!(state?.speak_replies && !call)) return false;
  if (!state.voice) {
    if (!speech.errored) { speech.errored = true; addMsg('error', 'This avatar has no voice yet: choose one in Settings to hear it speak.'); }
    return false;
  }
  return true;
}
function speakPiece(piece) {
  if (!speakable()) return;
  speech.buffer += piece;
  for (;;) {
    const m = speech.buffer.match(/^[\s\S]{30,}?[.!?\n]+(\s|$)/);
    if (!m) break;
    enqueue(m[0]);
    speech.buffer = speech.buffer.slice(m[0].length);
  }
}
function speakFlush() {
  if (speech.buffer.trim() && speakable()) enqueue(speech.buffer);
  speech.buffer = '';
}
function enqueue(text) {
  const clean = text.replace(/[*_`#>]/g, '').replace(/https?:\/\/\S+/g, 'a link').trim();
  if (!clean) return;
  const ticket = speech.ticket;
  speech.queue.push(fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: clean }) })
    .then(async (r) => {
      if (!r.ok) { const v = await r.json().catch(() => ({})); throw new Error(v.error || `${r.status}`); }
      return r.blob();
    }).then((blob) => ({ blob, ticket })));
  playNext();
}
async function playNext() {
  if (speech.playing || !speech.queue.length) return;
  speech.playing = true;
  const el = $('speech');
  try {
    const { blob, ticket } = await speech.queue.shift();
    if (ticket === speech.ticket) {
      if (!speech.ctx) {
        speech.ctx = new AudioContext();
        speech.analyser = speech.ctx.createAnalyser();
        speech.analyser.fftSize = 512;
        speech.levels = new Uint8Array(speech.analyser.fftSize);
        speech.ctx.createMediaElementSource(el).connect(speech.analyser);
        speech.analyser.connect(speech.ctx.destination);
      }
      await speech.ctx.resume();
      const url = URL.createObjectURL(blob);
      el.src = url;
      await el.play();
      window.__spoke = (window.__spoke || 0) + 1;
      await new Promise((done) => { el.onended = done; el.onerror = done; el.onpause = done; });
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    if (!speech.errored) { speech.errored = true; report('speech_failed', err.message); addMsg('error', `Could not speak the reply: ${err.message}`); }
  }
  speech.playing = false;
  playNext();
}
function stopSpeech() {
  speech.ticket++;
  speech.queue = [];
  speech.buffer = '';
  $('speech').pause();
}

async function startTalk() {
  stopSpeech();
  const b = $('talk');
  b.disabled = true; b.textContent = 'Connecting…';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('this browser only gives a page the microphone on https or localhost');
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    const { value, model } = await api('POST', '/api/voice/session');
    const pc = new RTCPeerConnection();
    call = { pc, mic, dc: null, ctx: null };
    mic.getTracks().forEach((t) => pc.addTrack(t, mic));
    pc.ontrack = (ev) => {
      $('voice').srcObject = ev.streams[0];
      const ctx = new AudioContext();
      call.ctx = ctx;
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(ev.streams[0]).connect(an);
      analyser = an; levels = new Uint8Array(an.fftSize);
    };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) stopTalk(pc.connectionState === 'failed' ? 'The voice connection failed.' : null); };
    const dc = pc.createDataChannel('oai-events');
    call.dc = dc;
    dc.onmessage = (m) => onVoiceEvent(JSON.parse(m.data));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
      method: 'POST', body: offer.sdp, headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/sdp' },
    });
    if (!r.ok) throw new Error(`the voice service answered ${r.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
    lastVoice = performance.now();
    b.textContent = 'Stop'; b.classList.add('on'); b.disabled = false;
    window.__voice = { up: true, events: [] };
  } catch (err) {
    report('talk_failed', err.name === 'NotAllowedError' ? 'microphone refused' : err.message);
    stopTalk(err.name === 'NotAllowedError' ? 'The browser refused the microphone.' : err.message);
  }
}

function stopTalk(note) {
  if (call) {
    call.mic.getTracks().forEach((t) => t.stop());
    call.pc.close();
    call.ctx?.close();
    call = null;
  }
  analyser = null;
  $('voice').srcObject = null;
  const b = $('talk');
  b.disabled = false; b.textContent = 'Talk'; b.classList.remove('on');
  if (note) addMsg('error', note);
}

$('talk').addEventListener('click', () => (call ? stopTalk() : startTalk()));

let voiceBubble = null;
async function onVoiceEvent(e) {
  window.__voice?.events.push(e.type);
  if (/speech_started|speech_stopped|response\.(created|done)|output_audio/.test(e.type)) lastVoice = performance.now();
  if (e.type === 'conversation.item.input_audio_transcription.completed' && e.transcript?.trim()) addMsg('you-said user', e.transcript.trim());
  if (e.type === 'response.output_audio_transcript.delta') {
    if (!voiceBubble) voiceBubble = addMsg('assistant', '');
    voiceBubble.textContent += e.delta;
    $('log').scrollTop = $('log').scrollHeight;
  }
  if (e.type === 'response.output_audio_transcript.done') voiceBubble = null;
  if (e.type === 'error') { report('voice_error', e.error?.code || e.error?.type || 'error'); addMsg('error', e.error?.message || 'voice error'); }
  if (e.type === 'response.function_call_arguments.done' && e.name === 'ask_agent') {
    lastVoice = performance.now();
    thinking = true;
    $('busy').hidden = false; $('busy').textContent = `${status.agent} is thinking…`;
    let output;
    try {
      const a = JSON.parse(e.arguments || '{}');
      output = (await api('POST', '/api/ask', { text: a.text || a.request || '' })).text;
    } catch (err) { output = `Could not reach the agent: ${err.message}`; }
    thinking = false;
    $('busy').hidden = true;
    lastVoice = performance.now();
    if (!call?.dc || call.dc.readyState !== 'open') return;
    call.dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: e.call_id, output } }));
    call.dc.send(JSON.stringify({ type: 'response.create' }));
  }
}

// --- start ---------------------------------------------------------------
async function renderMain() {
  document.body.classList.add('render');
  const done = (error) => fetch(`/api/render/${RENDER}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error || '' }) });
  try {
    const job = await api('GET', `/api/render/${RENDER}`);
    renderJob = job;
    renderer.setAnimationLoop(null);
    renderer.setPixelRatio(1);
    renderer.setSize(job.width, job.height, false);
    camera.aspect = job.width / job.height;
    camera.updateProjectionMatrix();
    await refresh();
    const until = performance.now() + 180000;
    while (!window.__avatar?.ready) {
      if (window.__avatar?.error) throw new Error(window.__avatar.error);
      if (performance.now() > until) throw new Error('the avatar did not load');
      await new Promise((r) => setTimeout(r, 100));
    }
    frameModel();
    // The background is in the first frame, not popping in a moment later; so is any prop the move,
    // the talk loop or the standing loop holds.
    await Promise.race([bg.ready, new Promise((r) => setTimeout(r, 15000))]);
    await motion.props.ready([job.name, motion.idleName, motion.talkName]);
    fixedDt = 1 / job.fps;
    motion.propsClipOnly = true;
    motion.props.performance = !!job.performance;
    motion.fidget = null;
    motion.nextFidget = 1e9;
    skipDraw = true;
    for (let i = 0; i < job.fps * 0.6; i++) animate();  // hair and springs settle, unrecorded
    skipDraw = false;
    const frame = async () => {
      animate();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
      const r = await fetch(`/api/render/${RENDER}/frame`, { method: 'POST', body: blob });
      if (!r.ok) throw new Error(`frame refused: ${r.status}`);
    };
    // The agent's spoken line, if any: its loudness per frame moves the mouth, from the move's start
    // (the server lays the sound itself under the video at the same moment).
    let lineLevels = null;
    if (job.audio) {
      const buf = await (await fetch(`/api/render/${RENDER}/audio`)).arrayBuffer();
      const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
      const audio = await ctx.decodeAudioData(buf);
      const data = audio.getChannelData(0);
      const per = Math.max(1, Math.floor(audio.sampleRate / job.fps));
      const rms = [];
      for (let i = 0; i < data.length; i += per) {
        let sum = 0;
        const end = Math.min(data.length, i + per);
        for (let k = i; k < end; k++) sum += data[k] * data[k];
        rms.push(Math.sqrt(sum / (end - i)));
      }
      const peak = Math.max(0.0001, ...rms);
      lineLevels = rms.map((v) => Math.min(1, (v / peak) * 1.2));
    }
    for (let i = 0; i < Math.round(job.fps * 0.3); i++) await frame();
    let seconds;
    if (GESTURES[job.name]) { motion.play(job.name); seconds = GESTURES[job.name].seconds; }
    else { await motion.playClip(job.name); seconds = motion.clip?.duration || 2; }
    // With a spoken line the video lasts as long as the line and no longer (the owner, 2026-11-15: past
    // the words it is only a body moving, mouth shut): a longer move is cut, a shorter one ends in the
    // standing loop. Without one, the move's own length.
    let tail = 0.5;
    if (lineLevels) { seconds = lineLevels.length / job.fps; tail = 0.3; }
    const n = Math.min(Math.round((seconds + tail) * job.fps), Math.round(job.max_seconds * job.fps));
    for (let i = 0; i < n; i++) {
      if (lineLevels) renderLevel = i < lineLevels.length ? lineLevels[i] : 0;
      await frame();
    }
    renderLevel = null;
    await done();
  } catch (err) {
    await done(err.message || String(err));
  }
}

// LANAgent: what the Android app (and any page that embeds this one) drives: the voice's loudness while it speaks,
// the thinking pose while the agent works, a move, a face. Each returns at once; none needs the page to be ready.
window.lanagentAvatar = {
  level(x) { external.level = Math.max(0, Math.min(1, Number(x) || 0)); external.at = performance.now(); },
  thinking(on) { thinking = !!on; },
  // Text arriving without a voice: the mouth moves softly for a moment, as on the page's own chat.
  texting(ms = 600) { textMouthUntil = performance.now() + Math.min(10000, Number(ms) || 600); },
  gesture(name) { if (name) playGesture(String(name)); },
  mood(name, seconds = 4) { if (!name) return; moodHold = { name: String(name), until: performance.now() + Number(seconds) * 1000 }; applyMood(); },
  ready() { return !!window.__avatar?.ready; },
};

async function start() {
  status = await (await fetch('/api/status')).json();
  if (RENDER && status.logged_in) return renderMain();
  if (!status.logged_in) { showGate(); return; }
  $('gate').hidden = true;
  $('app').hidden = false;
  $('name').textContent = status.agent;
  document.title = status.agent;
  if (!status.voice) { $('talk').disabled = true; $('talk').title = 'Talk needs an OpenAI API key on the agent'; }
  await refresh();
  const { lines } = await api('GET', '/api/chat');
  $('log').replaceChildren();
  lines.forEach((l) => addMsg(l.role, l.text));
  connectEvents();
}

resize();
vr = new VR({
  renderer, scene, camera,
  onEnter: () => { $('vr').textContent = 'Exit VR'; window.__avatar.vr = true; },
  onExit: () => { $('vr').textContent = 'VR'; if (window.__avatar) window.__avatar.vr = false; placeCamera(); resize(); },
  actions: () => [
    { label: call ? 'Stop' : 'Talk', fn: () => (call ? stopTalk() : startTalk()) },
    { label: 'Nod', fn: () => playGesture('nod') },
    { label: 'Exit', fn: () => vr.exit() },
  ],
  lines: () => [...document.querySelectorAll('#log .msg')].slice(-5).map((m) => ({ role: m.className, text: m.textContent })),
});
window.__reach = () => motion?.lastReach || {};
window.__handsVsHips = () => {
  if (!motion) return null;
  const hips = vrm.humanoid.getNormalizedBoneNode('hips').getWorldPosition(new THREE.Vector3());
  const out = {};
  for (const side of ['left', 'right']) { const h = motion.ik.handAt(side); out[side] = h ? [h.x - hips.x, h.y - hips.y, h.z - hips.z] : null; }
  const elbow = vrm.humanoid.getNormalizedBoneNode('rightLowerArm').getWorldPosition(new THREE.Vector3());
  const shoulder = vrm.humanoid.getNormalizedBoneNode('rightUpperArm').getWorldPosition(new THREE.Vector3());
  return { ...out, halfWidth: motion.halfWidth, waist: motion.waist, height: motion.ik.height, elbowBelowShoulder: shoulder.y - elbow.y, upperArm: shoulder.distanceTo(elbow) };
};
window.__hips = () => { const n = vrm?.humanoid?.getNormalizedBoneNode('hips'); return n ? n.getWorldPosition(new THREE.Vector3()).toArray() : null; };
window.__vrState = () => ({ presenting: renderer.xr.isPresenting, frames: vr.frames, rig: vr.rig.position.toArray(), rot: vr.rig.rotation.y, talk: !!call, hover: vr.hover?.label || null, buttons: vr.buttons.map((b) => b.label), lastGesture: window.__lastGesture || null });
VR.supported().then((yes) => { $('vr').hidden = !yes; });
$('vr').addEventListener('click', () => {
  (renderer.xr.isPresenting ? Promise.resolve(vr.exit()) : vr.enter()).catch((err) => addMsg('error', `VR did not start: ${err.message}`));
});
fillVroidLinks();
renderer.setAnimationLoop(animate);
start().catch((err) => { document.body.append(err.message); });
