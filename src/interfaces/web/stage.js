/**
 * The stage: what a program on the owner's own machines needs to draw this agent's body dancing (Gapless, the music player;
 * 2119 #635, the owner's yes 2026-11-25). Read only, and only with the stage key: the body worn now, the look on it, the
 * dances that suit it, the set it stands in. Nothing is pushed, nothing can be changed here.
 *
 *   GET /stage/v1/state         the state; ETag / 304
 *   GET /stage/v1/files/<sha>   a file the state names now; ETag = its sha256
 *
 * Over TLS only (its own port, STAGE_TLS_PORT or 8796, with the certificate in data/stage/tls-*.pem), or from this machine:
 * the key and a lent body never go over plain http.
 *
 * Off until a key was made (data/stage/key.sha256 holds only hashes: one line per program, `<hash>` or `<program> <hash>`;
 * Lull's line is made by pairing, see lullPairing). A lent body (the owner's Bots & Borgs link) says
 * `lent: true`: to be drawn, never kept.
 */
import express from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import https from 'https';
import { DATA_PATH } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';
import os from 'os';

const TYPES = { '.vrm': 'model/gltf-binary', '.vrma': 'model/gltf-binary', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
export const stageKeyFile = () => path.join(DATA_PATH, 'stage', 'key.sha256');

/** Whether this request carries the stage key. False when there is none. */
export async function stageAllowed(header, keyFile = stageKeyFile()) {
  const m = /^Bearer\s+(\S{20,200})$/.exec(String(header || ''));
  const wants = keyLines(await fs.readFile(keyFile, 'utf8').catch(() => '')).map(l => l.hash);
  if (!m || !wants.length) return false;
  const got = crypto.createHash('sha256').update(m[1]).digest();
  return wants.some(w => crypto.timingSafeEqual(got, Buffer.from(w, 'hex')));
}

/** The key file's lines: [{ program, hash }], program '' for a bare hash (the first key, Gapless's). */
function keyLines(text) {
  return String(text).split('\n').map(l => l.trim().toLowerCase().split(/\s+/)).map(w => w.length === 1 ? { program: '', hash: w[0] } : { program: w[0], hash: w[1] })
    .filter(l => /^[0-9a-f]{64}$/.test(l.hash || ''));
}

/** The address a phone on the LAN reaches the stage at: STAGE_PUBLIC_URL, else this machine's first private IPv4. */
export function stagePageUrl(port = Number(process.env.STAGE_TLS_PORT) || 8796) {
  if (process.env.STAGE_PUBLIC_URL) return process.env.STAGE_PUBLIC_URL.replace(/\/+$/, '');
  const ips = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
  // A home LAN first (192.168), never a container bridge (172.17/18) or a tunnel (the WireGuard 10.8, a VPN's 100.64).
  const lan = ips.find(a => /^192\.168\./.test(a)) || ips.find(a => /^10\./.test(a) && !/^10\.8\./.test(a)) || null;
  return lan ? `https://${lan}:${port}` : null;
}

/**
 * Pairing Lull (the owner's phone player) with this agent's stage: a new key for Lull only (any key Lull had before stops; the
 * other programs' keys stay), and the link Lull reads from its QR code (Lull 1.20, README "Agents dancing"):
 *   lull-stage:<page>#name=<agent>&key=<url-encoded key>&pin=<the certificate's sha256, 64 hex>
 *   https://updates.procomputation.com/lull/pair#name=..&key=..&url=<url-encoded page>&pin=..   (the same, tappable)
 * The key is in the fragment and only its hash stays here.
 */
export async function lullPairing({ name = 'agent', dir = path.join(DATA_PATH, 'stage'), url = stagePageUrl() } = {}) {
  const pem = await fs.readFile(path.join(dir, 'tls-cert.pem'), 'utf8').catch(() => null);
  if (!pem) throw new Error('the stage has no certificate yet');
  if (!url) throw new Error('no address for the stage');
  const pin = crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex');
  const key = crypto.randomBytes(32).toString('base64url');
  const file = path.join(dir, 'key.sha256');
  const kept = keyLines(await fs.readFile(file, 'utf8').catch(() => '')).filter(l => l.program !== 'lull');
  const lines = [...kept.map(l => (l.program ? `${l.program} ${l.hash}` : l.hash)), `lull ${crypto.createHash('sha256').update(key).digest('hex')}`];
  await fs.writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
  const agent = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const fields = `name=${encodeURIComponent(agent)}&key=${encodeURIComponent(key)}`;
  return {
    link: `lull-stage:${url}#${fields}&pin=${pin}`,
    // The tappable form (chats and mail don't make lull-stage: clickable): Lull is the verified app for it (2119 #683).
    linkHttps: `https://updates.procomputation.com/lull/pair#${fields}&url=${encodeURIComponent(url)}&pin=${pin}`,
    url, pin
  };
}

/** "pair with Lull", "Lull QR code", "dance in Lull", "connect Lull to you". */
export const LULL_PAIR = /\b(?:pair|link|connect|hook\s*up|add|set\s*up|qr|code)\b[\s\S]{0,40}\blull\b|\blull\b[\s\S]{0,40}\b(?:pair(?:ing)?|qr|code|link|connect)\b|\bdance\s+(?:in|on)\s+lull\b/i;

export function createStageRouter(agent, { keyFile = stageKeyFile(), store = () => { const e = agent?.apiManager?.apis?.get?.('botsandborgs'); return e?.enabled === false ? null : (e?.instance || e || null); } } = {}) {
  const r = express.Router();
  r.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.socket.encrypted && !/^(?:::1|(?:::ffff:)?127\.)/.test(req.socket.remoteAddress || '')) return res.status(403).json({ error: 'https only' });
    if (await stageAllowed(req.headers.authorization, keyFile).catch(() => false)) return next();
    return res.status(401).json({ error: 'the stage key' });
  });
  const read = async () => {
    const s = store();
    if (!s?.stageState) return null;
    return s.stageState();
  };
  r.get('/state', async (req, res) => {
    try {
      const got = await read();
      if (!got) return res.status(503).json({ error: 'no body to show' });
      const body = JSON.stringify(got.state);
      const tag = `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
      res.setHeader('ETag', tag);
      if (req.headers['if-none-match'] === tag) return res.status(304).end();
      res.type('application/json').send(body);
    } catch (e) { logger.warn(`Stage: ${e.message}`); res.status(500).json({ error: 'not readable now' }); }
  });
  r.get('/files/:sha', async (req, res) => {
    try {
      const got = await read();
      const file = /^[0-9a-f]{64}$/.test(req.params.sha) ? got?.files.get(req.params.sha) : null;
      if (!file) return res.status(404).json({ error: 'not named by the state now' });
      const tag = `"${req.params.sha}"`;
      res.setHeader('ETag', tag);
      if (req.headers['if-none-match'] === tag) return res.status(304).end();
      const { size } = await fs.stat(file);
      res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', size);
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (e) { logger.warn(`Stage: ${e.message}`); if (!res.headersSent) res.status(500).json({ error: 'not readable now' }); }
  });
  return r;
}

/** The stage on its own TLS port, when its certificate is there. Returns the server, or null. Never stops a start. */
export async function startStageTls(agent, { dir = path.join(DATA_PATH, 'stage'), port = Number(process.env.STAGE_TLS_PORT) || 8796, host, ...opts } = {}) {
  const [key, cert] = await Promise.all(['tls-key.pem', 'tls-cert.pem'].map(f => fs.readFile(path.join(dir, f)).catch(() => null)));
  if (!key || !cert) return null;
  try {
    const app = express();
    app.disable('x-powered-by');
    app.use('/stage/v1', createStageRouter(agent, opts));
    const server = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, app);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    server.on('error', e => logger.warn(`Stage: ${e.message}`));
    server.unref?.();
    logger.info(`Stage: TLS on port ${server.address().port}`);
    return server;
  } catch (e) { logger.warn(`Stage: no TLS port: ${e.message}`); return null; }
}
