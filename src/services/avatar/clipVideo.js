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
const HOST = 'http://clip.render';
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
const THREE = window.THREE; THREE.GLTFLoader = GLTFLoader;
const d = {
${methods}
};
window.setup = async ({ width, height, fps, seconds, loop, prop, background }) => {
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1); r.setSize(width, height); document.body.appendChild(r.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4050, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.2, 2.5, 2.5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc4ff, 1.2); rim.position.set(-2, 2, -2); scene.add(rim);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0.001; scene.add(floor);
  const l = new GLTFLoader(); l.register(p => new V.VRMLoaderPlugin(p));
  const vrm = (await l.loadAsync('/model.vrm')).userData.vrm;
  if (V.VRMUtils?.removeUnnecessaryJoints) V.VRMUtils.removeUnnecessaryJoints(vrm.scene);
  vrm.scene.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  scene.add(vrm.scene); d.currentVRM = vrm;
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
  // Frame the whole routine: where the body goes over the clip, not just where it starts.
  const box = new THREE.Box3(); const v = new THREE.Vector3();
  const bones = ['head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'hips', 'leftUpperArm', 'rightUpperArm'];
  for (let i = 0; i <= 24; i++) {
    mixer.setTime((Math.min(seconds, clip.duration) * i) / 24); vrm.update(0); vrm.scene.updateMatrixWorld(true);
    for (const b of bones) { const n = vrm.humanoid.getRawBoneNode(b); if (n) box.expandByPoint(n.getWorldPosition(v)); }
  }
  box.expandByPoint(new THREE.Vector3(box.min.x, 0, box.min.z));
  box.max.y += 0.18; // the top of the head is above the head bone
  if (poleX !== null) { box.expandByPoint(new THREE.Vector3(poleX, 0, 0)); }
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const cam = new THREE.PerspectiveCamera(30, width / height, 0.05, 50);
  const fov = THREE.MathUtils.degToRad(30);
  const fitH = (s.y * 1.04) / 2 / Math.tan(fov / 2);
  const fitW = (s.x * 1.08) / 2 / Math.tan(fov / 2) / cam.aspect;
  const dist = Math.max(fitH, fitW, 1.2);
  cam.position.set(c.x, c.y + s.y * 0.04, Math.max(c.z, box.max.z) + dist); cam.lookAt(c.x, c.y, c.z);
  // Settle the hair at the first pose, then play.
  mixer.setTime(0);
  for (let i = 0; i < 90; i++) vrm.update(1 / 60);
  action.reset().play(); mixer.setTime(0);
  window.frame = (i) => {
    if (i > 0) mixer.update(1 / fps);
    vrm.update(1 / fps);
    r.render(scene, cam);
    return r.domElement.toDataURL('image/jpeg', 0.9);
  };
  return { duration: clip.duration, tracks: clip.tracks.length, pole: poleX };
};
window.ready = true;
</script></body></html>`;
}

const MIME = { '.js': 'text/javascript', '.vrm': 'model/gltf-binary', '.vrma': 'model/gltf-binary', '.html': 'text/html' };
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

async function render({ modelPath, clipPath, loop = false, prop = null, seconds = null, fps = 24, width = 720, height = 960,
  background = '#121826', timeoutMs = 8 * 60 * 1000, launch = null } = {}) {
  const started = Date.now();
  const html = pageHtml(designerMethods(await fs.readFile(path.join(PUBLIC_DIR, 'avatar.html'), 'utf8')));
  const { default: puppeteer } = await import('puppeteer');
  const browser = await (launch || ((o) => puppeteer.launch(o)))({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${width},${height}`]
  });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-video-'));
  const out = path.join(tmp, 'clip.mp4');
  const timer = setTimeout(() => browser.close().catch(() => {}), timeoutMs);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      const u = new URL(req.url());
      if (u.origin !== HOST) return req.abort();
      try {
        let body;
        if (u.pathname === '/render.html') body = Buffer.from(html);
        else if (u.pathname === '/model.vrm') body = await fs.readFile(modelPath);
        else if (u.pathname === '/clip.vrma') body = await fs.readFile(clipPath);
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
    await page.goto(`${HOST}/render.html`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.ready === true', { timeout: 60000 }).catch(() => { throw new Error(`the render page did not start: ${pageErrors[0] || 'no error given'}`); });
    // The clip's length is known only once it is loaded, so the page is set up with a generous span first.
    const probe = await page.evaluate((o) => window.setup(o), { width, height, fps, seconds: 40, loop, prop, background });
    const total = videoSeconds(probe.duration, loop, { seconds });
    const frames = Math.max(1, Math.round(total * fps));
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out], { stdio: ['pipe', 'ignore', 'pipe'] });
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
    const facts = { seconds: +(frames / fps).toFixed(2), frames, fps, width, height, bytes: video.length, pole: probe.pole, ms: Date.now() - started };
    logger.info(`Clip video: ${path.basename(clipPath)} on ${path.basename(modelPath)}, ${facts.seconds}s, ${frames} frames, ${(video.length / 1048576).toFixed(1)} MB in ${(facts.ms / 1000).toFixed(0)}s`);
    return { video, ...facts };
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
