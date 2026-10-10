// cryptotools: JWS verification (Ed25519 receipts), HMAC webhook checks, sha256. No network:
// keys are generated here and the JWKS fetch is stubbed on the instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import CryptoToolsPlugin from '../../src/api/plugins/cryptotools.js';

const b64url = (b) => Buffer.from(b).toString('base64url');

function signJws(privateKey, header, claims) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign(null, Buffer.from(input), privateKey);
  return `${input}.${b64url(sig)}`;
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' };
const other = crypto.generateKeyPairSync('ed25519');
const claims = { typ: 'reapption.reaction-receipt.v1', iss: 'https://reapption.net', video_sha256: 'ab', exp: Math.floor(Date.now() / 1000) + 600 };
const receipt = signJws(privateKey, { alg: 'EdDSA', kid: 'k1' }, claims);

function plugin() {
  const p = new CryptoToolsPlugin({});
  p._jwks = async () => [{ ...other.publicKey.export({ format: 'jwk' }), kid: 'k0' }, jwk];
  return p;
}

test('verifyJws: an Ed25519 receipt verifies against the JWKS key with its kid, and expected claims are checked', async () => {
  const r = await plugin().execute({ action: 'verifyJws', jws: receipt, jwks_url: 'https://reapption.net/.well-known/jwks.json', expect: { typ: claims.typ, iss: claims.iss } });
  assert.equal(r.success, true);
  assert.equal(r.valid, true, r.result);
  assert.equal(r.kid, 'k1');
  assert.deepEqual(r.checks, { exp: true, typ: true, iss: true });
  assert.equal(r.claims.video_sha256, 'ab');
});

test('verifyJws: a tampered payload or the wrong key is invalid; a wrong iss fails the check', async () => {
  const [h, , s] = receipt.split('.');
  const forged = `${h}.${b64url(JSON.stringify({ ...claims, video_sha256: 'cd' }))}.${s}`;
  const r1 = await plugin().execute({ action: 'verifyJws', jws: forged, jwks_url: 'https://x/jwks.json' });
  assert.equal(r1.valid, false);
  assert.equal(r1.signatureValid, false);
  assert.match(r1.result, /INVALID/);

  const r2 = await plugin().execute({ action: 'verifyJws', jws: receipt, jwk: other.publicKey.export({ format: 'jwk' }) });
  assert.equal(r2.valid, false);

  const r3 = await plugin().execute({ action: 'verifyJws', jws: receipt, jwk, expect: { iss: 'https://evil.example' } });
  assert.equal(r3.signatureValid, true);
  assert.equal(r3.valid, false);
  assert.match(r3.result, /iss does not match/);
});

test('verifyJws: alg none and malformed tokens are refused; a PEM key works', async () => {
  const none = `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url('{}')}.${b64url('x')}`;
  const r = await plugin().execute({ action: 'verifyJws', jws: none, jwk });
  assert.equal(r.success, false);
  assert.match(r.error, /alg none/);
  assert.equal((await plugin().execute({ action: 'verifyJws', jws: 'abc', jwk })).success, false);
  const pem = publicKey.export({ format: 'pem', type: 'spki' });
  assert.equal((await plugin().execute({ action: 'verifyJws', jws: receipt, public_key: pem })).valid, true);
});

test('verifyJws: an ES256 token verifies (P1363 signature encoding)', async () => {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const input = `${b64url(JSON.stringify({ alg: 'ES256' }))}.${b64url('{"a":1}')}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' });
  const r = await plugin().execute({ action: 'verifyJws', jws: `${input}.${b64url(sig)}`, jwk: ec.publicKey.export({ format: 'jwk' }) });
  assert.equal(r.valid, true, r.result);
});

test('decodeJws says it did not verify', async () => {
  const r = await plugin().execute({ action: 'decodeJws', jws: receipt });
  assert.equal(r.verified, false);
  assert.equal(r.claims.iss, claims.iss);
});

test('hmac: computes sha256 and checks a "sha256=" webhook header', async () => {
  const body = '{"task_id":"t1","status":"ready"}';
  const want = crypto.createHmac('sha256', 'whsec').update(body).digest('hex');
  const r = await plugin().execute({ action: 'hmac', key: 'whsec', message: body });
  assert.equal(r.digest, want);
  assert.equal(r.header, `sha256=${want}`);
  assert.equal((await plugin().execute({ action: 'hmac', key: 'whsec', message: body, expect: `sha256=${want}` })).matches, true);
  assert.equal((await plugin().execute({ action: 'hmac', key: 'whsec', message: body + ' ', expect: `sha256=${want}` })).matches, false);
});

test('hmac: another agent cannot use a saved secret as the key', async () => {
  const r = await plugin().execute({ action: 'hmac', key: '{{secret:reapption.net.webhook_secret}}', message: 'x', _peer: 'Orbit' });
  assert.equal(r.success, false);
  assert.match(r.error, /cannot use a saved secret/);
});

test('sha256: text vector, expect match, and file paths outside the data dirs are refused', async () => {
  const r = await plugin().execute({ action: 'sha256', text: 'abc', expect: 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD' });
  assert.equal(r.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(r.matches, true);
  const f = await plugin().execute({ action: 'sha256', file: '/etc/passwd' });
  assert.equal(f.success, false);
  assert.match(f.error, /Only files under/);
});

// ---- detached payload tests ----------------------------------------------------------------

test('verifyJws: detached payload (empty payload part) verifies with external payload', async () => {
  const header = { alg: 'EdDSA', kid: 'k1' };
  const externalPayload = { typ: 'reapption.reaction-receipt.v1', iss: 'https://reapption.net', video_sha256: 'ab', exp: Math.floor(Date.now() / 1000) + 600 };
  const payloadBytes = Buffer.from(JSON.stringify(externalPayload));
  const input = `${b64url(JSON.stringify(header))}.${b64url(payloadBytes)}`;
  const sig = crypto.sign(null, Buffer.from(input), privateKey);
  const detachedJws = `${b64url(JSON.stringify(header))}..${b64url(sig)}`; // empty payload part
  const r = await plugin().execute({
    action: 'verifyJws',
    jws: detachedJws,
    jwks_url: 'https://reapption.net/.well-known/jwks.json',
    expect: { typ: externalPayload.typ, iss: externalPayload.iss },
    payload: JSON.stringify(externalPayload)
  });
  assert.equal(r.success, true);
  assert.equal(r.valid, true, r.result);
  assert.equal(r.kid, 'k1');
  assert.deepEqual(r.checks, { exp: true, typ: true, iss: true });
  assert.equal(r.claims.video_sha256, 'ab');
});

test('verifyJws: detached payload with tampered external payload fails signature', async () => {
  const header = { alg: 'EdDSA', kid: 'k1' };
  const originalPayload = { a: 1 };
  const tamperedPayload = { a: 2 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(Buffer.from(JSON.stringify(originalPayload)))}`;
  const sig = crypto.sign(null, Buffer.from(input), privateKey);
  const detachedJws = `${b64url(JSON.stringify(header))}..${b64url(sig)}`;
  const r = await plugin().execute({
    action: 'verifyJws',
    jws: detachedJws,
    jwk,
    payload: JSON.stringify(tamperedPayload)
  });
  assert.equal(r.success, true);
  assert.equal(r.signatureValid, false);
  assert.equal(r.valid, false);
  assert.match(r.result, /INVALID/);
});

test('verifyJws: detached JWS without payload parameter throws error', async () => {
  const header = { alg: 'EdDSA', kid: 'k1' };
  const externalPayload = { a: 1 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(Buffer.from(JSON.stringify(externalPayload)))}`;
  const sig = crypto.sign(null, Buffer.from(input), privateKey);
  const detachedJws = `${b64url(JSON.stringify(header))}..${b64url(sig)}`;
  const r = await plugin().execute({
    action: 'verifyJws',
    jws: detachedJws,
    jwk
  });
  assert.equal(r.success, false);
  assert.match(r.error, /empty payload.*detached/i);
});

test('decodeJws: detached JWS (empty payload) throws error', async () => {
  const header = { alg: 'EdDSA', kid: 'k1' };
  const externalPayload = { a: 1 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(Buffer.from(JSON.stringify(externalPayload)))}`;
  const sig = crypto.sign(null, Buffer.from(input), privateKey);
  const detachedJws = `${b64url(JSON.stringify(header))}..${b64url(sig)}`;
  const r = await plugin().execute({ action: 'decodeJws', jws: detachedJws });
  assert.equal(r.success, false);
  assert.match(r.error, /empty payload.*detached/i);
});

test('verifyJws: a separate payload alongside an embedded one is refused, not substituted', async () => {
  const header = { alg: 'EdDSA', kid: 'k1' };
  const input = `${b64url(JSON.stringify(header))}.${b64url(Buffer.from(JSON.stringify({ a: 1 })))}`;
  const sig = crypto.sign(null, Buffer.from(input), privateKey);
  const r = await plugin().execute({ action: 'verifyJws', jws: `${input}.${b64url(sig)}`, jwk, payload: JSON.stringify({ a: 2 }) });
  assert.equal(r.success, false);
  assert.match(r.error, /embeds its own payload/);
});

test('verifyJws: RFC 7797 unencoded detached payload (b64:false) verifies', async () => {
  const header = { alg: 'EdDSA', kid: 'k1', b64: false, crit: ['b64'] };
  const body = '{"amount":"10.00","to":"x"}';
  const h = b64url(JSON.stringify(header));
  const sig = crypto.sign(null, Buffer.from(`${h}.${body}`), privateKey);
  const r = await plugin().execute({ action: 'verifyJws', jws: `${h}..${b64url(sig)}`, jwk, payload: body });
  assert.equal(r.success, true);
  assert.equal(r.signatureValid, true, r.result);
  assert.equal(r.claims.amount, '10.00');
});

test('verifyJws: a non-object detached payload is returned verbatim and runs no claim checks', async () => {
  const header = { alg: 'EdDSA', kid: 'k1' };
  const h = b64url(JSON.stringify(header));
  const sig = crypto.sign(null, Buffer.from(`${h}.${b64url(Buffer.from('hello'))}`), privateKey);
  const r = await plugin().execute({ action: 'verifyJws', jws: `${h}..${b64url(sig)}`, jwk, payload: 'hello' });
  assert.equal(r.signatureValid, true, r.result);
  assert.equal(r.claims, 'hello');
  assert.deepEqual(r.checks, {});
});
