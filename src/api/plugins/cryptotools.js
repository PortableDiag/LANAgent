import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { decrypt } from '../../utils/encryption.js';
import { fetchPublic } from '../../services/webtools/fetchPublic.js';
import { DATA_PATH, TEMP_PATH, UPLOADS_PATH, WORKSPACE_PATH } from '../../utils/paths.js';
import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';

/**
 * Signatures and digests: verify a JWS against a JWKS, HMAC a webhook body, sha256 a file or URL.
 *
 * A service that pays or settles on a signed receipt expects the agent to check it. Reapption
 * hands out Ed25519 JWS receipts (verified against https://reapption.net/.well-known/jwks.json)
 * and signs its webhooks with HMAC-SHA256; ALICE had no way to check either, so the room was
 * told to "verify the receipt through another agent that can" (Trellis card 344, 2026-10-05).
 *
 * Nothing here moves money or touches the network beyond public GETs (a JWKS, a file to hash).
 * An HMAC key may be an http-plugin placeholder ({{secret:<host>.<field>}}); only the digest is
 * returned, never the key, and another agent's request cannot use a saved secret.
 */

const MAX_HASH_BYTES = 110 * 1024 * 1024;   // Reapption payloads are up to 100 MB
const JWKS_TTL_MS = 10 * 60 * 1000;
const PLACEHOLDER = /^\{\{\s*secret:([a-z0-9._-]+)\s*\}\}$/i;
const HMAC_ALGS = ['sha256', 'sha384', 'sha512', 'sha1'];
const FILE_ROOTS = [DATA_PATH, TEMP_PATH, UPLOADS_PATH, WORKSPACE_PATH, '/tmp'];

const b64urlDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlEncode = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Split a compact JWS into its parts, parsed. Throws on anything that is not one.
 *
 * Detached payloads (RFC 7515 Appendix F): the JWS carries an empty payload part
 * ("header..signature") and the payload travels separately as externalPayload.
 * The signing input is then header + "." + base64url(payload), or, when the
 * header sets "b64": false (RFC 7797), header + "." + the raw payload bytes.
 * An externalPayload alongside a JWS that already embeds one is refused rather
 * than silently substituted, so the claims reported are always the signed ones.
 */
export function parseJws(jws, externalPayload = null) {
  const parts = String(jws || '').trim().split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]*$/.test(p)) || !parts[0] || !parts[2]) {
    throw new Error('jws must be a compact JWS: three base64url parts joined by dots');
  }
  let header, payload, signingInput;
  try { header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')); } catch { throw new Error('the JWS header is not JSON'); }

  const detached = externalPayload !== null && externalPayload !== undefined;
  if (detached) {
    if (parts[1] !== '') throw new Error('this JWS embeds its own payload; omit the separate payload parameter');
    const payloadBytes = Buffer.isBuffer(externalPayload)
      ? externalPayload
      : Buffer.from(typeof externalPayload === 'string' ? externalPayload : JSON.stringify(externalPayload), 'utf8');
    const encoded = header.b64 === false ? payloadBytes : Buffer.from(b64urlEncode(payloadBytes));
    signingInput = Buffer.concat([Buffer.from(`${parts[0]}.`), encoded]);
    const raw = payloadBytes.toString('utf8');
    try { payload = JSON.parse(raw); } catch { payload = raw; }
  } else {
    if (parts[1] === '') throw new Error('JWS has an empty payload (detached); provide the payload separately to verify');
    const raw = b64urlDecode(parts[1]).toString('utf8');
    try { payload = JSON.parse(raw); } catch { payload = raw; }
    signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  }

  return { header, payload, signingInput, signature: b64urlDecode(parts[2]) };
}

/** Verify a signature with a node KeyObject for the JWS `alg`. Unknown algs and `none` are refused. */
export function verifySignature(alg, key, data, sig) {
  switch (alg) {
    case 'EdDSA': case 'Ed25519': return crypto.verify(null, data, key, sig);
    case 'ES256': return crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    case 'ES384': return crypto.verify('sha384', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    case 'RS256': return crypto.verify('sha256', data, key, sig);
    case 'RS384': return crypto.verify('sha384', data, key, sig);
    case 'RS512': return crypto.verify('sha512', data, key, sig);
    case 'PS256': return crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
    default: throw new Error(`alg ${alg} is not supported (EdDSA, ES256/384, RS256/384/512, PS256)`);
  }
}

/** Compare two strings in constant time (lengths may differ). */
function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export default class CryptoToolsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'cryptotools';
    this.version = '1.0.0';
    this.description = 'Verify signatures and compute digests: check a JWS (e.g. an Ed25519-signed receipt) against a JWKS URL or key, compute or check an HMAC (webhook signatures), and sha256 a text, file or URL';
    this.commands = [
      {
        command: 'verifyJws',
        description: 'Verify a signed JWS (a receipt or token) against a JWKS URL, a JWK or a PEM public key, and return its header and claims. Optionally check expected claims such as typ and iss. For detached JWS (payload transmitted separately), provide the payload as the \'payload\' parameter.',
        usage: 'verifyJws({ jws: "eyJ…", jwks_url: "https://reapption.net/.well-known/jwks.json", expect: { typ: "reapption.reaction-receipt.v1", iss: "https://reapption.net" }, payload: "<detached payload string or JSON>" })  // or jwk: {...} / public_key: "-----BEGIN PUBLIC KEY-----…"',
        examples: [
          'verify this receipt signature',
          'check the JWS against the jwks url',
          'verify the Ed25519 signed receipt',
          'is this signed token valid',
          'verify the reapption receipt'
        ]
      },
      {
        command: 'decodeJws',
        description: 'Show a JWS header and claims WITHOUT checking the signature (use verifyJws to trust it)',
        usage: 'decodeJws({ jws: "eyJ…" })',
        examples: ['decode this JWS', 'what is inside this token']
      },
      {
        command: 'hmac',
        description: 'Compute an HMAC (default SHA-256, hex) of a message, or check it against an expected signature such as a webhook header "sha256=…". The key can be a saved {{secret:<host>.<field>}} placeholder.',
        usage: 'hmac({ key: "{{secret:reapption.net.webhook_secret}}", message: "<raw body>", algorithm: "sha256", expect: "sha256=ab12…" })',
        examples: ['compute the HMAC-SHA256 of this body', 'check the webhook signature', 'sign this payload with hmac']
      },
      {
        command: 'sha256',
        description: 'SHA-256 of a text, base64 data, a local file, or a public URL (downloaded, up to 110 MB). Optionally compare with an expected hex digest.',
        usage: 'sha256({ url: "https://…/reaction.webm", expect: "<hex>" })  // or text / base64 / file',
        examples: ['sha256 this file', 'hash the downloaded video', 'check the video sha256 matches the receipt', 'compute the sha256 of this url']
      }
    ];
    this.jwksCache = new Map();
  }

  async initialize() {
    this.initialized = true;
  }

  async execute(params = {}) {
    const { action } = params;
    try {
      switch (action) {
        case 'verifyJws': return await this.verifyJws(params);
        case 'decodeJws': return this.decodeJws(params);
        case 'hmac': return await this.hmac(params);
        case 'sha256': return await this.sha256(params);
        default: return { success: false, error: `Unknown action: ${action}. Use verifyJws, decodeJws, hmac or sha256.` };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ---- JWS ----------------------------------------------------------------------------------

  async _jwks(url) {
    const hit = this.jwksCache.get(url);
    if (hit && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
    const res = await fetchPublic(url, { responseType: 'json', maxBytes: 256 * 1024, headers: { Accept: 'application/json' } });
    if (res.status !== 200) throw new Error(`jwks_url answered ${res.status}`);
    const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    if (!Array.isArray(body?.keys) || !body.keys.length) throw new Error('jwks_url returned no keys');
    this.jwksCache.set(url, { at: Date.now(), keys: body.keys });
    return body.keys;
  }

  async _candidateKeys({ header, jwks_url, jwk, public_key }) {
    if (public_key) return [{ kid: null, key: crypto.createPublicKey(String(public_key)) }];
    if (jwk) {
      const j = typeof jwk === 'string' ? JSON.parse(jwk) : jwk;
      return [{ kid: j.kid || null, key: crypto.createPublicKey({ key: j, format: 'jwk' }) }];
    }
    if (!jwks_url) throw new Error('Give jwks_url, jwk or public_key to verify against (decodeJws reads without verifying)');
    const keys = await this._jwks(String(jwks_url));
    const usable = keys.filter(k => !k.use || k.use === 'sig');
    const pick = header.kid ? usable.filter(k => k.kid === header.kid) : usable;
    if (!pick.length) throw new Error(`No key with kid ${header.kid} in ${jwks_url}`);
    return pick.map(k => ({ kid: k.kid || null, key: crypto.createPublicKey({ key: k, format: 'jwk' }) }));
  }

  /**
   * Verify a JWS. If the optional `payload` parameter is provided, it is used as the detached
   * payload (the JWS may have an empty payload part). Otherwise the embedded payload is used.
   */
  async verifyJws({ jws, jwks_url, jwksUrl, jwk, public_key, publicKey, expect = null, payload = null } = {}) {
    const { header, payload: parsedPayload, signingInput, signature } = parseJws(jws, payload);
    if (!header.alg || header.alg === 'none') throw new Error('The JWS has no signing algorithm (alg none is never accepted)');
    const keys = await this._candidateKeys({ header, jwks_url: jwks_url || jwksUrl, jwk, public_key: public_key || publicKey });

    let matched = null;
    for (const k of keys) {
      if (verifySignature(header.alg, k.key, signingInput, signature)) { matched = k; break; }
    }

    const checks = {};
    const claims = parsedPayload && typeof parsedPayload === 'object' ? parsedPayload : null;
    const now = Math.floor(Date.now() / 1000);
    if (claims?.exp != null) checks.exp = Number(claims.exp) > now;
    if (claims?.nbf != null) checks.nbf = Number(claims.nbf) <= now + 60;
    const wanted = typeof expect === 'string' ? JSON.parse(expect) : expect;
    for (const [field, value] of Object.entries(wanted || {})) {
      // typ may sit in the header (JOSE) or the claims; accept either.
      const got = field === 'typ' ? (claims?.typ ?? header.typ) : claims?.[field];
      checks[field] = JSON.stringify(got) === JSON.stringify(value);
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([f]) => f);
    const valid = !!matched && failed.length === 0;

    return {
      success: true,
      valid,
      signatureValid: !!matched,
      alg: header.alg,
      kid: matched?.kid ?? header.kid ?? null,
      checks,
      header,
      claims: parsedPayload,
      result: !matched
        ? `Signature INVALID: no ${keys.length > 1 ? 'key' : 'given key'} verifies this ${header.alg} JWS. Do not trust its claims.`
        : failed.length
          ? `Signature valid, but ${failed.join(', ')} ${failed.length > 1 ? 'do' : 'does'} not match what was expected. Treat it as not valid.`
          : `Valid ${header.alg} signature${matched.kid ? ` (kid ${matched.kid})` : ''}${Object.keys(checks).length ? `; ${Object.keys(checks).join(', ')} checked` : ''}.`
    };
  }

  decodeJws({ jws } = {}) {
    const { header, payload } = parseJws(jws);
    return { success: true, verified: false, header, claims: payload, result: 'Decoded only: the signature was NOT checked. Use verifyJws before relying on these claims.' };
  }

  // ---- HMAC ---------------------------------------------------------------------------------

  async _resolveKey(key, peer) {
    const m = PLACEHOLDER.exec(String(key ?? '').trim());
    if (!m) return String(key ?? '');
    if (peer) throw new Error('Another agent\'s request cannot use a saved secret');
    const stored = await PluginSettings.getCached('http', 'secrets').catch(() => null);
    const entry = stored?.[m[1].toLowerCase()];
    if (!entry) throw new Error(`No saved secret named ${m[1].toLowerCase()} (http listSecrets shows what is saved)`);
    return decrypt(entry.value);
  }

  async hmac({ key, secret, message, body, algorithm = 'sha256', encoding = 'hex', expect, _peer } = {}) {
    const k = await this._resolveKey(key ?? secret, _peer);
    if (!k) throw new Error('hmac needs a key');
    const msg = message ?? body;
    if (msg == null) throw new Error('hmac needs the message (the exact raw body that was signed)');
    const alg = String(algorithm).toLowerCase().replace(/^hmac-?/, '').replace('-', '');
    if (!HMAC_ALGS.includes(alg)) throw new Error(`algorithm must be one of ${HMAC_ALGS.join(', ')}`);
    const enc = encoding === 'base64' ? 'base64' : 'hex';
    const digest = crypto.createHmac(alg, k).update(typeof msg === 'string' ? msg : JSON.stringify(msg)).digest(enc);
    const out = { success: true, algorithm: alg, digest, header: `${alg}=${digest}` };
    if (expect != null && expect !== '') {
      const want = String(expect).trim().replace(new RegExp(`^${alg}=`, 'i'), '');
      out.matches = enc === 'hex' ? sameText(want.toLowerCase(), digest) : sameText(want, digest);
      out.result = out.matches ? `HMAC-${alg.toUpperCase()} matches.` : `HMAC-${alg.toUpperCase()} does NOT match: wrong key, or the message is not the exact raw body that was signed.`;
    } else {
      out.result = `${alg}=${digest}`;
    }
    return out;
  }

  // ---- sha256 -------------------------------------------------------------------------------

  async _fileBytes(file) {
    const abs = path.resolve(String(file));
    const base = path.basename(abs).toLowerCase();
    if (base.startsWith('.env') || /\.(pem|key)$/.test(base)) throw new Error(`${abs} is not hashed: it holds credentials`);
    if (!FILE_ROOTS.some(r => abs === r || abs.startsWith(r + path.sep))) {
      throw new Error(`Only files under ${FILE_ROOTS.join(', ')} can be hashed`);
    }
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new Error(`No file at ${abs}`);
    if (st.size > MAX_HASH_BYTES) throw new Error(`${abs} is larger than ${MAX_HASH_BYTES} bytes`);
    return fs.readFile(abs);
  }

  async sha256({ text, base64, file, path: filePath, url, expect } = {}) {
    let bytes, source;
    if (url) {
      const res = await fetchPublic(String(url), { responseType: 'arraybuffer', maxBytes: MAX_HASH_BYTES, timeout: 60000, deadlineMs: 5 * 60 * 1000 });
      if (res.status !== 200) throw new Error(`${url} answered ${res.status}`);
      bytes = Buffer.from(res.data); source = 'url';
    } else if (file || filePath) {
      bytes = await this._fileBytes(file || filePath); source = 'file';
    } else if (base64 != null) {
      bytes = Buffer.from(String(base64), 'base64'); source = 'base64';
    } else if (text != null) {
      bytes = Buffer.from(String(text), 'utf8'); source = 'text';
    } else {
      throw new Error('sha256 needs text, base64, file or url');
    }
    const hex = crypto.createHash('sha256').update(bytes).digest('hex');
    const out = { success: true, sha256: hex, bytes: bytes.length, source };
    if (expect != null && expect !== '') {
      out.matches = sameText(String(expect).trim().toLowerCase().replace(/^sha256[:=]/, ''), hex);
      out.result = out.matches ? `sha256 matches (${bytes.length} bytes).` : `sha256 does NOT match: got ${hex} over ${bytes.length} bytes.`;
    } else {
      out.result = `sha256 ${hex} (${bytes.length} bytes)`;
    }
    return out;
  }
}
