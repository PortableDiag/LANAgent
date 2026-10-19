import crypto from 'node:crypto';

/**
 * End-to-end framing for the TextX Agent Protocol (TextX repo docs/agent-protocol.md §3.3).
 *
 * A pairing is a public `kid` plus a 32-byte key that only the QR code carries. Every frame
 * between the phone and the agent is AES-256-GCM under that key, so a relay in between
 * (api.lanagent.net) routes by kid and sees no content. AAD binds a frame to its pairing and
 * its direction: a frame the agent sent cannot be replayed back to it as the phone's.
 */

export const P2A = 'p2a'; // phone → agent
export const A2P = 'a2p'; // agent → phone

const NONCE = 12;
const TAG = 16;

export function newPairing() {
  return {
    kid: crypto.randomBytes(12).toString('base64url'),
    key: crypto.randomBytes(32).toString('base64url')
  };
}

export function pairingUri(base, kid, key) {
  return `textx-agent:${String(base).replace(/\/+$/, '')}#${kid}.${key}`;
}

function keyBytes(key) {
  const k = Buffer.from(String(key), 'base64url');
  if (k.length !== 32) throw new Error('pairing key must be 32 bytes');
  return k;
}

const aad = (kid, dir) => Buffer.from(`textx1|${kid}|${dir}`, 'ascii');

export function sealBytes(key, kid, dir, plain) {
  const nonce = crypto.randomBytes(NONCE);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(key), nonce);
  cipher.setAAD(aad(kid, dir));
  const ct = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

/** Throws on a frame that was not sealed under this pairing, in this direction. */
export function openBytes(key, kid, dir, sealed) {
  const buf = Buffer.from(sealed);
  if (buf.length < NONCE + TAG) throw new Error('frame too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(key), buf.subarray(0, NONCE));
  decipher.setAAD(aad(kid, dir));
  decipher.setAuthTag(buf.subarray(buf.length - TAG));
  return Buffer.concat([decipher.update(buf.subarray(NONCE, buf.length - TAG)), decipher.final()]);
}

export function sealJson(key, kid, dir, value) {
  return { x: sealBytes(key, kid, dir, JSON.stringify(value)).toString('base64url') };
}

export function openJson(key, kid, dir, frame) {
  const obj = typeof frame === 'string' ? JSON.parse(frame) : frame;
  if (!obj || typeof obj.x !== 'string') throw new Error('not a sealed frame');
  return JSON.parse(openBytes(key, kid, dir, Buffer.from(obj.x, 'base64url')).toString('utf8'));
}

/** `Authorization: Bearer <kid>` — the kid alone grants nothing without the key. */
export function kidFromAuth(header) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{8,64})\s*$/.exec(String(header || ''));
  return m ? m[1] : null;
}

// ULIDs for envelope ids (§4): 48-bit ms time + 80 random bits, Crockford base32.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let t = '';
  for (let i = 0, ms = now; i < 10; i++, ms = Math.floor(ms / 32)) t = B32[ms % 32] + t;
  const r = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += B32[r[i] % 32];
  return t + s;
}
