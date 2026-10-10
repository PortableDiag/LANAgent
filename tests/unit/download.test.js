/**
 * Magic-number content-type detection for the download routes.
 *
 * The download token carries no content type, so before this the routes served
 * `application/octet-stream` for everything. Each signature below was wrong on
 * the first implementation — these cases pin the corrections:
 *   - ID3 is 3 bytes; a 4-byte slice never matched it (Buffer.equals length).
 *   - JPEG guarantees only `FF D8 FF`; E0/E1 alone misses E2..EF, DB, EE.
 *   - MP4's first 4 bytes are the ftyp box SIZE (varies); `ftyp` sits at offset 4.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMimeType } from '../../src/api/external/routes/download.js';

const buf = (...bytes) => Buffer.from(bytes);
const ftyp = (size, brand) => Buffer.concat([
  buf(0x00, 0x00, 0x00, size), Buffer.from('ftyp', 'latin1'), Buffer.from(brand, 'latin1')
]);

test('recognises document and image signatures', () => {
  assert.equal(detectMimeType(Buffer.from('%PDF-1.4', 'latin1')), 'application/pdf');
  assert.equal(detectMimeType(buf(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)), 'image/png');
  assert.equal(detectMimeType(Buffer.from('GIF89a', 'latin1')), 'image/gif');
});

test('JPEG matches on FF D8 FF regardless of the segment marker', () => {
  // 0xE0/0xE1 are JFIF/Exif; the rest are equally valid and used to be missed.
  for (const marker of [0xE0, 0xE1, 0xE2, 0xED, 0xEE, 0xDB]) {
    assert.equal(detectMimeType(buf(0xFF, 0xD8, 0xFF, marker)), 'image/jpeg',
      `marker 0x${marker.toString(16)} not detected`);
  }
});

test('ID3 is a three-byte magic (the four-byte compare never matched)', () => {
  assert.equal(detectMimeType(buf(0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0)), 'audio/mpeg');
});

test('MP4 is detected by ftyp at offset 4, at any box size', () => {
  // 0x18 and 0x14 were the only sizes hardcoded before; muxers emit others.
  for (const size of [0x14, 0x18, 0x1C, 0x20, 0x24]) {
    assert.equal(detectMimeType(ftyp(size, 'isom')), 'video/mp4', `box size 0x${size.toString(16)}`);
  }
});

test('separates the ISO base media brands we actually serve', () => {
  assert.equal(detectMimeType(ftyp(0x20, 'M4A ')), 'audio/mp4');
  assert.equal(detectMimeType(ftyp(0x20, 'qt  ')), 'video/quicktime');
  assert.equal(detectMimeType(ftyp(0x20, 'mp42')), 'video/mp4');
});

test('recognises webm/mkv — yt-dlp emits these routinely', () => {
  assert.equal(detectMimeType(buf(0x1A, 0x45, 0xDF, 0xA3, 0x01, 0, 0, 0)), 'video/webm');
});

test('falls back to octet-stream for unknown, short, and non-buffer input', () => {
  assert.equal(detectMimeType(buf(0xDE, 0xAD, 0xBE, 0xEF)), 'application/octet-stream');
  assert.equal(detectMimeType(buf(0x25, 0x50)), 'application/octet-stream');   // too short
  assert.equal(detectMimeType(Buffer.alloc(0)), 'application/octet-stream');
  assert.equal(detectMimeType(null), 'application/octet-stream');
  assert.equal(detectMimeType('%PDF'), 'application/octet-stream');            // not a Buffer
});

test('a truncated ftyp header does not read past the bytes actually present', () => {
  // 8 bytes: 'ftyp' present but no brand. Must not throw or invent a brand.
  const short = Buffer.concat([buf(0, 0, 0, 0x20), Buffer.from('ftyp', 'latin1')]);
  assert.equal(detectMimeType(short), 'application/octet-stream');
});

// --- HEAD /:token ----------------------------------------------------------
// Express answers HEAD with a GET handler when no HEAD route exists, and the GET
// handler consumes a download. HEAD must report the file without spending one.
import express from 'express';
import { fileURLToPath } from 'node:url';
import downloadRouter from '../../src/api/external/routes/download.js';
import { generateDownloadToken, inspectDownloadToken, revokeDownloadToken } from '../../src/api/external/services/downloadTokenService.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const fixture = fileURLToPath(new URL('../../package.json', import.meta.url));

async function withServer(fn) {
  const app = express();
  app.use('/dl', downloadRouter);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}/dl`); }
  finally { server.close(); }
}

test('HEAD returns size/type headers and does not consume a download', async () => {
  const token = generateDownloadToken({ filePath: fixture, filename: 'package.json', agentId: 'a', maxDownloads: 2 });
  await withServer(async (base) => {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${base}/${token}`, { method: 'HEAD' });
      assert.equal(r.status, 200);
      assert.equal(Number(r.headers.get('content-length')), (await import('node:fs')).statSync(fixture).size);
      assert.match(r.headers.get('content-disposition'), /package\.json/);
      assert.equal(r.headers.get('accept-ranges'), 'bytes');
    }
  });
  assert.equal(inspectDownloadToken(token).remainingDownloads, 2);
});

test('HEAD mirrors GET availability: bad token 401, revoked token 410', async () => {
  const token = generateDownloadToken({ filePath: fixture, filename: 'package.json', agentId: 'a', maxDownloads: 1 });
  revokeDownloadToken(token);
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/not-a-token`, { method: 'HEAD' })).status, 401);
    assert.equal((await fetch(`${base}/${token}`, { method: 'HEAD' })).status, 410);
  });
});
