/**
 * Field-level encrypt/decrypt helpers, plus key-rotation fallback.
 *
 * The headline property is immutability of the input. The original implementation
 * used a shallow `{ ...obj }` and then wrote through the shared nested reference,
 * so encrypting 'user.profile.email' overwrote the caller's own object with the
 * ciphertext. These tests pin that the input is untouched at every depth.
 *
 * The golden-vector test pins the on-disk format: production's wallet seed is stored
 * with this module, so a ciphertext produced by the pre-rotation version must keep
 * decrypting byte-for-byte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Set up keys for key rotation tests
// Fixed current key so the golden vector below (made with the pre-rotation module) decrypts.
const keyNew = '6c616e6167656e742d676f6c64656e2d766563746f722d6b65792d3030303031';
const keyOld = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_KEY = keyNew;
process.env.ENCRYPTION_KEY_PREVIOUS = keyOld;

const {
  encryptField,
  decryptField,
  encrypt,
  decrypt,
  reEncrypt,
  generateEncryptionKey,
  isEncryptionConfigured,
  clearKeyCache,
  getKeyCacheStats,
} = await import('../../src/utils/encryption.js');

// Helper to encrypt with a specific key (mimics module's format)
function encryptWithKey(text, keyBuffer) {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const derivedKey = crypto.pbkdf2Sync(keyBuffer, salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

// ---------------------------------------------------------------------------
// Existing tests (unchanged)
// ---------------------------------------------------------------------------

test('round-trips a nested string field', () => {
  const obj = { user: { profile: { email: 'test@example.com' } } };
  const enc = encryptField(obj, 'user.profile.email');
  assert.notEqual(enc.user.profile.email, 'test@example.com');
  assert.equal(decryptField(enc, 'user.profile.email').user.profile.email, 'test@example.com');
});

test('leaves the input object completely unmodified', () => {
  const obj = { user: { profile: { email: 'test@example.com', age: 30 } } };
  const before = JSON.parse(JSON.stringify(obj));

  const enc = encryptField(obj, 'user.profile.email');

  assert.deepEqual(obj, before, 'encryptField must not mutate its input');
  assert.notEqual(enc.user.profile.email, obj.user.profile.email);

  const encBefore = JSON.parse(JSON.stringify(enc));
  decryptField(enc, 'user.profile.email');
  assert.deepEqual(enc, encBefore, 'decryptField must not mutate its input');
});

test('does not share nested references with the input', () => {
  const obj = { a: { b: { c: 'secret' } } };
  const enc = encryptField(obj, 'a.b.c');
  assert.notEqual(enc.a, obj.a, 'level 1 must be cloned');
  assert.notEqual(enc.a.b, obj.a.b, 'level 2 must be cloned');
});

test('round-trips a top-level field', () => {
  const obj = { token: 'abc123' };
  assert.equal(decryptField(encryptField(obj, 'token'), 'token').token, 'abc123');
});

test('round-trips an object value through JSON', () => {
  const obj = { user: { details: { age: 30, city: 'New York' } } };
  const enc = encryptField(obj, 'user.details');
  assert.equal(typeof enc.user.details, 'string');
  assert.deepEqual(decryptField(enc, 'user.details').user.details, { age: 30, city: 'New York' });
});

test('round-trips an array value', () => {
  const obj = { tags: ['a', 'b'] };
  assert.deepEqual(decryptField(encryptField(obj, 'tags'), 'tags').tags, ['a', 'b']);
});

test('unrelated sibling fields survive untouched', () => {
  const obj = { user: { profile: { email: 'e@x.com', name: 'Ada' } } };
  const enc = encryptField(obj, 'user.profile.email');
  assert.equal(enc.user.profile.name, 'Ada');
});

test('rejects a missing leaf and a missing branch', () => {
  assert.throws(() => encryptField({ a: { b: 1 } }, 'a.nope'), /does not exist/);
  assert.throws(() => encryptField({ a: { b: 1 } }, 'x.y.z'), /does not exist/);
});

test('rejects missing arguments', () => {
  assert.throws(() => encryptField(null, 'a'), /required/);
  assert.throws(() => encryptField({ a: 1 }, ''), /required/);
});

test('decrypting a field that was never encrypted leaves it alone', () => {
  const obj = { note: 'plain text' };
  assert.equal(decryptField(obj, 'note').note, 'plain text');
});

// ---------------------------------------------------------------------------
// New tests for key rotation support
// ---------------------------------------------------------------------------

test('golden vector from the pre-rotation module still decrypts with the current key', () => {
  const golden = '7qF+7erKorqnsSlMqXwl59n4qoukenPW251s9p+xA/gfB4Bcyay+yoil3BKh5w8/GxOzlBfW1FJYPc8EIxLMaUJtjs8FqjsZhRCZ4zS3ELRtyPb4o5O4gYkokretpkC0ehjC7SXvju8i9Dda37YdvwsagIdtZNTEFTTXdlNRyN37hkQwnZqGP/HlzBEXSMZPu8Msxw==';
  const pt = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  assert.equal(decrypt(golden), pt);
  assert.equal(decrypt(golden, []), pt, 'current key alone must suffice');
});

test('new ciphertext keeps the salt|iv|tag|data layout under the current key', () => {
  const pt = 'layout check';
  const c = encrypt(pt);
  assert.equal(Buffer.from(c, 'base64').length, 32 + 16 + 16 + Buffer.byteLength(pt));
  assert.equal(encryptWithKey(pt, Buffer.from(keyNew, 'hex')).length, c.length);
  assert.equal(decrypt(encryptWithKey(pt, Buffer.from(keyNew, 'hex')), []), pt);
});

test('a non-array second argument (map index) is ignored', () => {
  const c = encrypt('x');
  assert.deepEqual([c, c].map(decrypt), ['x', 'x']);
});

test('encrypt and decrypt round-trip', () => {
  const plain = 'secret data';
  const ciphertext = encrypt(plain);
  assert.notEqual(ciphertext, plain);
  assert.equal(decrypt(ciphertext), plain);
});

test('decrypt with explicit previous keys succeeds when current key fails', () => {
  const plain = 'data encrypted with old key';
  const otherKey = crypto.randomBytes(32);
  const ciphertext = encryptWithKey(plain, otherKey);
  // current key is keyNew, which won't match. Pass otherKey as previous.
  const result = decrypt(ciphertext, [otherKey]);
  assert.equal(result, plain);
});

test('decrypt fails when no key matches', () => {
  const plain = 'data encrypted with unknown key';
  const unknownKey = crypto.randomBytes(32);
  const ciphertext = encryptWithKey(plain, unknownKey);
  // No previous keys provided, and env previous is keyOld, which doesn't match.
  assert.throws(() => decrypt(ciphertext), /Failed to decrypt/);
});

test('reEncrypt re-encrypts data from old key to current key', () => {
  const plain = 'rotate me';
  const oldKeyBuffer = Buffer.from(keyOld, 'hex');
  const ciphertext = encryptWithKey(plain, oldKeyBuffer);
  // reEncrypt uses getPreviousKeys() which reads env and includes keyOld.
  const newCiphertext = reEncrypt(ciphertext);
  // Now decrypt with current key only (no previous keys)
  const result = decrypt(newCiphertext, []);
  assert.equal(result, plain);
});

test('generateEncryptionKey returns 64 hex characters', () => {
  const key = generateEncryptionKey();
  assert.equal(key.length, 64);
  assert(/^[0-9a-f]{64}$/.test(key));
});

test('isEncryptionConfigured returns true for valid key', () => {
  // current env key is 64 hex, so true
  assert.equal(isEncryptionConfigured(), true);
  // temporarily change to invalid
  const original = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'short';
  assert.equal(isEncryptionConfigured(), false);
  process.env.ENCRYPTION_KEY = original;
});

test('clearKeyCache and getKeyCacheStats do not throw', () => {
  assert.doesNotThrow(() => clearKeyCache());
  const stats = getKeyCacheStats();
  assert.equal(typeof stats.keys, 'number');
  assert.equal(typeof stats.hits, 'number');
  assert.equal(typeof stats.misses, 'number');
});

test('encrypt, decrypt, reEncrypt handle empty string', () => {
  assert.equal(encrypt(''), '');
  assert.equal(decrypt(''), '');
  assert.equal(reEncrypt(''), '');
});
