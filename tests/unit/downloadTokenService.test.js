import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectDownloadToken,
  generateDownloadToken,
  consumeDownload,
  revokeDownloadToken
} from '../../src/api/external/services/downloadTokenService.js';

const makeToken = (overrides = {}) => generateDownloadToken({
  filePath: '/path/to/file.txt',
  filename: 'file.txt',
  agentId: 'agent-123',
  maxDownloads: 5,
  expiresInMinutes: 10,
  ...overrides
});

test('inspectDownloadToken returns correct metadata for valid token', () => {
  const result = inspectDownloadToken(makeToken());

  assert.ok(result.isValid);
  assert.ok(result.usable);
  assert.strictEqual(result.filePath, '/path/to/file.txt');
  assert.strictEqual(result.filename, 'file.txt');
  assert.strictEqual(result.agentId, 'agent-123');
  assert.strictEqual(result.maxDownloads, 5);
  assert.strictEqual(result.remainingDownloads, 5);
  assert.strictEqual(result.consumedCount, 0);
  assert.strictEqual(result.isRevoked, false);
  assert.ok(result.expiration);
});

test('inspection does not consume; consumption is reflected without side effects', () => {
  const token = makeToken({ maxDownloads: 2 });

  // repeated inspection never decrements
  inspectDownloadToken(token);
  inspectDownloadToken(token);
  assert.strictEqual(inspectDownloadToken(token).remainingDownloads, 2);

  assert.strictEqual(consumeDownload(token), true);
  const afterConsume = inspectDownloadToken(token);
  assert.strictEqual(afterConsume.remainingDownloads, 1);
  assert.strictEqual(afterConsume.consumedCount, 1);
  assert.ok(afterConsume.usable);
});

test('revoked token: still isValid (signature) but not usable, expiration reported', () => {
  const token = makeToken();
  revokeDownloadToken(token);

  const result = inspectDownloadToken(token);
  assert.strictEqual(result.isValid, true);
  assert.strictEqual(result.usable, false);
  assert.strictEqual(result.isRevoked, true);
  assert.strictEqual(result.remainingDownloads, 0);
  // counter entry is deleted on revoke — expiration falls back to metadata TTL
  assert.ok(result.expiration);
});

test('garbage and wrong-type tokens are invalid, never throw', () => {
  const garbage = inspectDownloadToken('not-a-jwt');
  assert.strictEqual(garbage.isValid, false);
  assert.strictEqual(garbage.usable, false);
  assert.ok(garbage.error);
});
