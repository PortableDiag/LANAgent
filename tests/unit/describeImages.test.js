// describeImages (src/utils/describeImages.js): one vision call per distinct picture+question,
// base64 input accepted, and a failure comes back as { error } instead of throwing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeImages } from '../../src/utils/describeImages.js';

function counter(answer = 'a red square') {
  const pm = { calls: 0, async analyzeImage() { pm.calls++; return { analysis: answer }; } };
  return pm;
}

test('the same picture asked the same way is described once', async () => {
  const pm = counter();
  const pic = { name: 'p.png', mime: 'image/png', buffer: Buffer.from('cache-same-' + Date.now()) };
  const [a] = await describeImages(pm, [pic], 'what colour?');
  const [b] = await describeImages(pm, [pic], 'what colour?');
  assert.equal(a.text, 'a red square');
  assert.equal(b.text, 'a red square');
  assert.equal(pm.calls, 1);
});

test('a different question about the same picture looks again', async () => {
  const pm = counter();
  const pic = { name: 'p.png', mime: 'image/png', buffer: Buffer.from('cache-q-' + Date.now()) };
  await describeImages(pm, [pic], 'what colour?');
  await describeImages(pm, [pic], 'what shape?');
  assert.equal(pm.calls, 2);
});

test('base64 input is decoded; missing data and provider errors return { error }', async () => {
  let seen;
  const pm = { async analyzeImage(buf) { seen = buf; return 'ok'; } };
  const raw = Buffer.from('b64-' + Date.now());
  const [r] = await describeImages(pm, [{ name: 'x', base64: raw.toString('base64') }]);
  assert.equal(r.text, 'ok');
  assert.ok(seen.equals(raw));

  const [none] = await describeImages(pm, [{ name: 'y' }]);
  assert.match(none.error, /no image data/);

  const bad = { async analyzeImage() { throw new Error('vision down'); } };
  const [e] = await describeImages(bad, [{ name: 'z', buffer: Buffer.from('err-' + Date.now()) }]);
  assert.equal(e.error, 'vision down');
});

test('isPicture: only what the vision model takes; a HEIC original is left to its JPEG still (TextX 0.4.84)', async () => {
  const { isPicture } = await import('../../src/utils/describeImages.js');
  for (const m of ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'IMAGE/JPEG; charset=binary']) assert.equal(isPicture(m), true, m);
  for (const m of ['image/heic', 'image/heic-sequence', 'image/heif', 'image/tiff', 'audio/mp4']) assert.equal(isPicture(m, 'sticker.heics'), false, m);
  assert.equal(isPicture('application/octet-stream', 'photo.jpg'), true, 'a generic type falls back to the name');
  assert.equal(isPicture('', 'still-1.jpg'), true);
  assert.equal(isPicture('', 'sticker.heic'), false);
});
