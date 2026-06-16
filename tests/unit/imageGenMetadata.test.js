import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// downloadTokenService needs JWT_SECRET set at import time (it's read
// each call via getSecret() — but better to set before first use to
// avoid any caching surprises).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-imageGen-metadata';

const { generateDownloadToken, verifyDownloadToken } = await import('../../src/api/external/services/downloadTokenService.js');

let tmpFile;
let testToken;

before(async () => {
  // Generate a real 64x48 PNG via sharp so the metadata extraction has
  // something concrete to read. Avoids hand-rolling PNG bytes.
  const buf = await sharp({
    create: { width: 64, height: 48, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.8 } }
  }).png().toBuffer();
  tmpFile = path.join(os.tmpdir(), `metadata-test-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await fs.writeFile(tmpFile, buf);
  testToken = generateDownloadToken({
    filePath: tmpFile,
    filename: 'metadata-test.png',
    agentId: 'agent-test',
    maxDownloads: 3,
    expiresInMinutes: 5
  });
});

after(async () => {
  if (tmpFile) await fs.unlink(tmpFile).catch(() => {});
});

test('verifyDownloadToken returns the encoded payload', () => {
  const decoded = verifyDownloadToken(testToken);
  assert.ok(decoded);
  assert.equal(decoded.filename, 'metadata-test.png');
  assert.equal(decoded.agentId, 'agent-test');
  assert.equal(decoded.maxDownloads, 3);
  assert.equal(decoded.filePath, tmpFile);
  assert.ok(decoded.exp > Math.floor(Date.now() / 1000));
});

test('sharp.metadata() returns the technical fields the route relies on', async () => {
  const m = await sharp(tmpFile).metadata();
  assert.equal(m.format, 'png');
  assert.equal(m.width, 64);
  assert.equal(m.height, 48);
  assert.equal(m.hasAlpha, true);
  // No EXIF/ICC on a sharp-generated PNG — route normalizes both to null bytes
  assert.equal(m.exif, undefined);
  assert.equal(m.icc, undefined);
  // size is undefined when sharp reads from a path (vs a buffer); the route
  // intentionally `?? null`s it so this is expected, not a bug.
  assert.ok(m.size === undefined || typeof m.size === 'number');
});

test('verifyDownloadToken rejects a tampered token', () => {
  // Flip a byte in the signature segment — must not pass verification
  const parts = testToken.split('.');
  const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}xx`;
  assert.equal(verifyDownloadToken(tampered), null);
});

test('verifyDownloadToken rejects garbage input', () => {
  assert.equal(verifyDownloadToken('not.a.jwt'), null);
  assert.equal(verifyDownloadToken(''), null);
  assert.equal(verifyDownloadToken('aaaa'), null);
});
