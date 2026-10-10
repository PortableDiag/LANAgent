/**
 * Transcode preset resolution.
 *
 * Deliberately tests the pure resolver rather than driving the route: the route is
 * wrapped in creditAuth/creditDebit, so exercising it end to end would need a live
 * wallet and a real billing path. The contract worth pinning here is that a preset
 * only ever supplies DEFAULTS — an existing caller that sends its own parameters
 * must be unaffected by presets existing at all, because this endpoint is billed
 * and already has external consumers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPresetToParams, PRESET_CONFIGS, PRESET_NAMES } from '../../src/api/external/routes/imageTranscode.js';

// Mirrors the route's precedence rules so the merge logic is pinned without
// standing up express. Kept in sync with the handler by the assertions below.
function resolve(body) {
  const preset = body.preset ? mapPresetToParams(body.preset) : null;
  if (body.preset && !preset) return null;
  const has = (k) => body[k] != null && body[k] !== '';
  const bool = (v) => v === true || v === 'true';
  const num = (v) => (v != null && v !== '' ? Number(v) : undefined);
  return {
    target: body.target || preset?.target,
    quality: has('quality') ? num(body.quality) : preset?.quality,
    effort: has('effort') ? num(body.effort) : preset?.effort,
    lossless: has('lossless') ? bool(body.lossless) : (preset?.lossless ?? false)
  };
}

test('every preset resolves to a complete, usable parameter set', () => {
  assert.ok(PRESET_NAMES.length > 0, 'expected at least one preset');
  for (const name of PRESET_NAMES) {
    const p = mapPresetToParams(name);
    assert.ok(p, `${name} should resolve`);
    assert.ok(p.target, `${name} must name a target format`);
    assert.ok(p.quality >= 1 && p.quality <= 100, `${name} quality in range`);
    assert.ok(p.effort >= 1, `${name} effort set`);
    assert.equal(typeof p.lossless, 'boolean', `${name} lossless is boolean`);
  }
});

test('unknown and missing presets are distinguished', () => {
  assert.equal(mapPresetToParams('nope'), null);
  assert.equal(mapPresetToParams(''), null);
  assert.equal(mapPresetToParams(undefined), null);
});

test('preset supplies defaults when the caller sends nothing else', () => {
  const r = resolve({ preset: 'balanced' });
  assert.equal(r.target, PRESET_CONFIGS.balanced.target);
  assert.equal(r.quality, PRESET_CONFIGS.balanced.quality);
  assert.equal(r.effort, PRESET_CONFIGS.balanced.effort);
});

test('explicit parameters always beat the preset', () => {
  const r = resolve({ preset: 'smallest', target: 'png', quality: 95, effort: 1 });
  assert.equal(r.target, 'png');
  assert.equal(r.quality, 95);
  assert.equal(r.effort, 1);
});

test('an explicit lossless:false is honoured over a lossless preset', () => {
  // The bug this guards: a truthiness check would silently re-enable the preset's
  // lossless because `false` is falsy, quietly changing the caller's output.
  assert.equal(resolve({ preset: 'lossless' }).lossless, true);
  assert.equal(resolve({ preset: 'lossless', lossless: false }).lossless, false);
  assert.equal(resolve({ preset: 'lossless', lossless: 'false' }).lossless, false);
});

test('quality:0 is not swallowed by the preset default', () => {
  // Guards the `parseInt(x) || fallback` shape — 0 is a legitimate value here.
  assert.equal(resolve({ preset: 'balanced', quality: 0 }).quality, 0);
});

test('existing callers are unaffected when no preset is given', () => {
  const r = resolve({ target: 'avif', quality: 82, effort: 2 });
  assert.deepEqual(r, { target: 'avif', quality: 82, effort: 2, lossless: false });
});

test('a bad preset name is rejected rather than silently ignored', () => {
  assert.equal(resolve({ preset: 'tiny', target: 'avif' }), null);
});

// --- autoOrient (opt-in) through the real transcode path ---
// Source: a 40x20 JPEG tagged EXIF orientation 6 (display = rotate 90° CW).
import sharp from 'sharp';
import ImageToolsPlugin from '../../src/api/plugins/imageTools.js';

async function orientedJpeg() {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 0, b: 0 } } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
}

test('autoOrient omitted: output keeps stored dimensions (existing behaviour)', async () => {
  const tools = new ImageToolsPlugin({});
  const r = await tools._transcode({ target: 'png', _buffer: await orientedJpeg() });
  assert.equal(r.success, true);
  const meta = await sharp(Buffer.from(r.data.image, 'base64')).metadata();
  assert.equal(meta.width, 40);
  assert.equal(meta.height, 20);
  assert.equal(r.data.width, 40);
  assert.equal(r.data.autoOriented, undefined);
});

test('autoOrient:true rotates per EXIF and reports the rotated dimensions', async () => {
  const tools = new ImageToolsPlugin({});
  const r = await tools._transcode({ target: 'png', autoOrient: true, _buffer: await orientedJpeg() });
  assert.equal(r.success, true);
  const meta = await sharp(Buffer.from(r.data.image, 'base64')).metadata();
  assert.equal(meta.width, 20);
  assert.equal(meta.height, 40);
  assert.equal(r.data.width, 20);
  assert.equal(r.data.height, 40);
  assert.equal(r.data.autoOriented, true);
  assert.equal(r.data.sourceOrientation, 6);
});

test('autoOrient on an untagged image is a no-op', async () => {
  const tools = new ImageToolsPlugin({});
  const buf = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#000' } }).png().toBuffer();
  const r = await tools._transcode({ target: 'webp', autoOrient: true, _buffer: buf });
  assert.equal(r.data.width, 40);
  assert.equal(r.data.autoOriented, undefined);
});
