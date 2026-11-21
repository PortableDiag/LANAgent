// The owner's saved look (the store's spec, 2119 #575) run for real in headless Chrome with the render page's three.js:
// pieces by extras.bnb_piece, colours by material name, shape keys by name. public/lib/vrm-look.js = AvatarX 0.4.6's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/interfaces/web/public');
const HOST = 'http://look.test';

/** A glTF with two one-triangle meshes (Body, Shirt), each its own material, Shirt with a shape key "Smile". */
function gltf() {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const morph = new Float32Array([0, 0.1, 0, 0, 0.1, 0, 0, 0.1, 0]);
  const buf = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(morph.buffer)]);
  return {
    asset: { version: '2.0' },
    buffers: [{ byteLength: buf.length, uri: `data:application/octet-stream;base64,${buf.toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0.1, 0], max: [0, 0.1, 0] }
    ],
    materials: [{ name: 'Body', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }, { name: 'Shirt', pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } }],
    meshes: [
      { name: 'Body', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
      { name: 'Shirt', primitives: [{ attributes: { POSITION: 0 }, material: 1, targets: [{ POSITION: 1 }] }], weights: [0], extras: { targetNames: ['Smile'] } }
    ],
    nodes: [
      { name: 'Body', mesh: 0, extras: { bnb_piece: 'Body', bnb_default_visible: true, bnb_kind: 'body' } },
      { name: 'Shirt', mesh: 1, extras: { bnb_piece: 'Shirt', bnb_default_visible: true, bnb_kind: 'clothing' } },
      { name: 'Hat', mesh: 0, extras: { bnb_piece: 'Hat', bnb_default_visible: false, bnb_kind: 'accessory' } },
      { name: 'Root', children: [0, 1, 2] }
    ],
    scenes: [{ nodes: [3] }], scene: 0
  };
}

const page = `<!doctype html><html><body>
<script src="/lib/three.r183.min.js"></script>
<script type="importmap">{ "imports": { "three": "/lib/three.r183.module.js", "three/addons/": "/lib/addons/" } }</script>
<script type="module">
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { wearLook } from '/lib/vrm-look.js';
window.run = async (look) => {
  const g = await new GLTFLoader().loadAsync('/m.gltf');
  const vrm = { scene: g.scene };
  const worn = wearLook(vrm, look);
  worn.apply(vrm);
  const by = (n) => { let x = null; g.scene.traverse((o) => { if (o.userData?.bnb_piece === n) x = o; }); return x; };
  const shirtMesh = by('Shirt');
  return {
    visible: { Body: by('Body').visible, Shirt: by('Shirt').visible, Hat: by('Hat').visible },
    body: '#' + by('Body').material.color.getHexString(),
    smile: shirtMesh.morphTargetInfluences?.[shirtMesh.morphTargetDictionary?.Smile],
    applied: { colors: worn.colors, morphs: worn.morphs, hidden: worn.hidden }
  };
};
window.ready = true;
</script></body></html>`;

test('a look hides unlisted pieces, tints a material and sets a shape key; no look keeps the author\'s defaults', { timeout: 90000 }, async () => {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', ...(process.env.PUPPETEER_EXECUTABLE_PATH || !(await fs.stat('/usr/bin/google-chrome').catch(() => null)) ? {} : { executablePath: '/usr/bin/google-chrome' }), args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader-webgl'] });
  try {
    const p = await browser.newPage();
    await p.setRequestInterception(true);
    p.on('request', async (req) => {
      const u = new URL(req.url());
      try {
        if (u.pathname === '/look.html') return req.respond({ status: 200, contentType: 'text/html', body: page });
        if (u.pathname === '/m.gltf') return req.respond({ status: 200, contentType: 'model/gltf+json', body: JSON.stringify(gltf()) });
        if (u.pathname.startsWith('/lib/')) return req.respond({ status: 200, contentType: 'text/javascript', body: await fs.readFile(path.join(PUBLIC, u.pathname)) });
        if (u.protocol === 'data:') return req.continue();
      } catch { /* fall through */ }
      req.respond({ status: 404, body: '' });
    });
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    p.on('requestfailed', (r) => errors.push(`failed ${r.url()}`));
    await p.goto(`${HOST}/look.html`);
    await p.waitForFunction('window.ready === true', { timeout: 30000 }).catch(() => { throw new Error(`the look page did not start: ${errors.join('; ')}`); });
    const plain = await p.evaluate(() => window.run(null));
    assert.deepEqual(plain.visible, { Body: true, Shirt: true, Hat: false }, 'no look: the author\'s defaults');
    const worn = await p.evaluate(() => window.run({ pieces: ['Body', 'Hat'], colors: { Body: { tint: '#ff0000' } }, morphs: { Smile: 0.4 } }));
    assert.deepEqual(worn.visible, { Body: true, Shirt: false, Hat: true });
    assert.equal(worn.body, '#ff0000');
    assert.ok(Math.abs(worn.smile - 0.4) < 1e-6, `smile ${worn.smile}`);
    assert.deepEqual(worn.applied.hidden, ['Shirt']);
    assert.deepEqual(worn.applied.colors, ['Body']);
    assert.deepEqual(worn.applied.morphs, ['Smile']);
  } finally {
    await browser.close();
  }
});
