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
const THREE = window.THREE; THREE.GLTFLoader = GLTFLoader;
const d = {
${methods}
};
window.setup = async ({ width, height, fps, seconds, loop, prop, props = [], background, backgroundImage = false, mouth = null, framing = 'full', look = null }) => {
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1); r.setSize(width, height); document.body.appendChild(r.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  // A background scene (Bots & Borgs backgrounds): cover the frame, cropped to its shape, never stretched.
  if (backgroundImage) {
    const tex = await new THREE.TextureLoader().loadAsync('/background.jpg');
    tex.colorSpace = THREE.SRGBColorSpace;
    const ia = tex.image.width / tex.image.height, va = width / height;
    if (ia > va) { tex.repeat.set(va / ia, 1); tex.offset.set((1 - va / ia) / 2, 0); } else { tex.repeat.set(1, ia / va); tex.offset.set(0, (1 - ia / va) / 2); }
    scene.background = tex;
  }
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4050, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.2, 2.5, 2.5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc4ff, 1.2); rim.position.set(-2, 2, -2); scene.add(rim);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0.001; scene.add(floor);
  const l = new GLTFLoader(); l.register(p => new V.VRMLoaderPlugin(p));
  const vrm = (await l.loadAsync(window.MODEL_URL || '/model.vrm')).userData.vrm;
  if (V.VRMUtils?.removeUnnecessaryJoints) V.VRMUtils.removeUnnecessaryJoints(vrm.scene);
  vrm.scene.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  scene.add(vrm.scene); d.currentVRM = vrm;
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
  // Settle the hair at the first pose, then play.
  mixer.setTime(0);
  for (let i = 0; i < 90; i++) vrm.update(1 / 60);
  action.reset().play(); mixer.setTime(0);
  // A voice-over moves the mouth: "aa" opens with the voice's loudness in each frame (2026-11-11).
  const em = vrm.expressionManager;
  const canTalk = !!(mouth && em && em.getExpression && em.getExpression('aa'));
  window.frame = (i) => {
    if (i > 0) mixer.update(1 / fps);
    updateProps(placed, action.time, i > 0 ? 1 / fps : 0); // the store's show windows and the props' own animations
    if (canTalk) em.setValue('aa', mouth[i] || 0);
    vrm.update(1 / fps);
    worn.apply(vrm); // the look's shape keys, again after the expressions
    r.render(scene, cam);
    return r.domElement.toDataURL('image/jpeg', 0.9);
  };
  return { duration: clip.duration, tracks: clip.tracks.length, pole: poleX, talks: canTalk, framing, props: placed.map(o => o.name), look: { colors: worn.colors, morphs: worn.morphs, hidden: worn.hidden } };
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
  return { url: `${origin}${secret}`, origin, path: secret, close: () => new Promise((ok) => server.close(() => ok())) };
}
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
  background = '#121826', backgroundPath = null, framing = 'full', timeoutMs = 8 * 60 * 1000, launch = null, voice = null, look = null } = {}) {
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
      // The voice starts 0.3 s in, so the mouth does too.
      mouth: said?.mouth ? [...new Array(Math.round(VOICE_LEAD_S * fps)).fill(0), ...said.mouth] : null });
    // With a voice-over the video runs at least as long as the voice (the clip holds its last pose, or loops).
    const total = said ? spokenSeconds(probe.duration, loop, said.seconds) : videoSeconds(probe.duration, loop, { seconds });
    const frames = Math.max(1, Math.round(total * fps));
    const audioArgs = audioFile ? ['-itsoffset', String(VOICE_LEAD_S), '-i', audioFile, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '128k'] : [];
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      ...audioArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...(audioFile ? [] : ['-an']), out], { stdio: ['pipe', 'ignore', 'pipe'] });
    let ffErr = '';
    ff.stderr.on('data', (b) => { ffErr += b; });
    const done = new Promise((resolve, reject) => ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${ffErr.trim() || `exit ${code}`}`)))));
    for (let i = 0; i < frames; i++) {
      const url = await page.evaluate((n) => window.frame(n), i);
      if (!ff.stdin.write(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
    await done;
    const video = await fs.readFile(out);
    const facts = { seconds: +(frames / fps).toFixed(2), frames, fps, width, height, bytes: video.length, pole: probe.pole, props: probe.props || [], ms: Date.now() - started, voice: !!said, lipSync: !!probe.talks };
    if (pageProps.length && facts.props.length < pageProps.length) logger.warn(`Clip video: ${facts.props.length} of ${pageProps.length} props shown on ${path.basename(clipPath)}`);
    logger.info(`Clip video: ${path.basename(clipPath)} on ${path.basename(modelPath)}${facts.props.length ? ` with ${facts.props.join(', ')}` : ''}, ${facts.seconds}s, ${frames} frames, ${(video.length / 1048576).toFixed(1)} MB in ${(facts.ms / 1000).toFixed(0)}s`);
    return { video, ...facts };
  } finally {
    clearTimeout(timer);
    await model.close().catch(() => {});
    await browser.close().catch(() => {});
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
    await model.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
