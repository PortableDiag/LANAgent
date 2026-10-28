import fs from 'fs/promises';
import path from 'path';
import crypto from 'node:crypto';
import { P2A, A2P, kidFromAuth, openJson, sealJson, openBytes, sealBytes } from './textxCrypto.js';

/** Longest a GET may be held for `wait` (the relay forwards a request for at most 30 s). */
export const LONG_POLL_MAX_S = 25;

/**
 * The TextX endpoint, independent of how a request arrives. The local Express/WebSocket
 * endpoint (interfaces/web/textx.js) and the relay link (textxRelayClient.js) both call
 * `http()` and `ws()`, so the same code answers on the LAN and from anywhere.
 *
 *   POST /textx/v1/messages     sealed [envelope…]     → sealed {acks}
 *   GET  /textx/v1/messages     ?since=<cursor>        → sealed {envelopes, cursor}
 *   POST /textx/v1/files        sealed bytes           → sealed {url}
 *   GET  /textx/v1/files/<id>                          → sealed bytes
 *   GET  /textx/v1/avatar                              → sealed bytes
 *   WS   /textx/v1/ws           one sealed envelope per text frame
 */

export const MAX_FILE = 5 * 1024 * 1024;
export const INLINE_MAX = 256 * 1024;
const FILE_TTL_MS = 7 * 24 * 3600 * 1000;
const BAD_FRAMES_BEFORE_CLOSE = 3;

const json = (status, value) => ({ status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(value)) });
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain' };

export function createTransport(hub, { filesDir, avatarFile = () => null, logger = console, socketSilentMs = 75000, socketKeepAliveMs = 30000 } = {}) {
  const fileId = () => crypto.randomBytes(16).toString('base64url');
  const filePath = (device, id) => path.join(filesDir, String(device.id), id.replace(/[^A-Za-z0-9_-]/g, ''));

  async function saveFile(device, data, meta) {
    const id = fileId();
    await fs.mkdir(path.join(filesDir, String(device.id)), { recursive: true });
    await fs.writeFile(filePath(device, id), data);
    await fs.writeFile(`${filePath(device, id)}.json`, JSON.stringify({ ...meta, size: data.length, at: Date.now() }));
    return id;
  }

  const fileUrl = (device, id) => `${String(device.base || '').replace(/\/+$/, '')}/textx/v1/files/${id}`;

  // The hub reads phone uploads named by URL and attaches agent results (photos, audio) to replies.
  hub.readFile = async (device, url) => {
    const m = /\/textx\/v1\/files\/([A-Za-z0-9_-]+)$/.exec(String(url));
    if (!m) throw new Error('not one of this agent\'s file urls');
    return fs.readFile(filePath(device, m[1]));
  };
  hub.attachFile = async (device, result) => {
    const stat = await fs.stat(result.path);
    if (stat.size > MAX_FILE) return null;
    const data = await fs.readFile(result.path);
    const name = result.filename || path.basename(result.path);
    const mime = result.mimeType || MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
    if (result.cleanup) fs.unlink(result.path).catch(() => {});
    if (data.length <= INLINE_MAX) return { name, mime, size: data.length, data_b64: data.toString('base64') };
    return { name, mime, size: data.length, url: fileUrl(device, await saveFile(device, data, { name, mime })) };
  };
  hub.avatarUrl = (device) => (device.base ? `${String(device.base).replace(/\/+$/, '')}/textx/v1/avatar` : undefined);

  async function auth(headers = {}) {
    const kid = kidFromAuth(headers.authorization);
    const device = kid ? await hub.deviceByKid(kid) : null;
    return device && device.key ? device : null;
  }

  /** One HTTP request → { status, headers, body: Buffer }. */
  async function http({ method, path: p, query = '', headers = {}, body = null }) {
    const device = await auth(headers);
    if (!device) return json(401, { error: 'unknown pairing' });
    const seal = (v) => json(200, sealJson(device.key, device.kid, A2P, v));
    // Which phone this is (§3.1 device binding; one pairing is one phone). POST: the batch's
    // leading hello. GET and files: ?device=. X-TextX-Device is accepted as an alias for both.
    // Not secret, and useless without the key.
    const params = new URLSearchParams(query);
    const headerDev = headers['x-textx-device'] ? String(headers['x-textx-device']).slice(0, 128) : null;
    const askedDev = params.get('device') || headerDev;
    // Logged with only the first 4 characters of each id: enough to tell a missing device from a wrong
    // one (the PhoneAPI handover's 401s could not be told apart, Trellis 2119 #274).
    const short = (v) => (v ? `${String(v).slice(0, 4)}…` : 'missing');
    const refuse = (why = '', got = askedDev) => {
      logger.warn?.(`TextX: ${device.name} ${method} ${p} refused (${why || 'device'}): sent ${short(got)}, bound ${short(device.deviceId)}`);
      return json(401, { error: 'this pairing belongs to another device, or the request did not say which device it is' });
    };
    const raw = body ? Buffer.from(body) : Buffer.alloc(0);
    try {
      if (p === '/textx/v1/messages' && method === 'POST') {
        let envelopes;
        try { envelopes = openJson(device.key, device.kid, P2A, raw.toString('utf8')); } catch { return json(400, { error: 'bad_frame' }); }
        if (!Array.isArray(envelopes)) return json(400, { error: 'body must be an array of envelopes' });
        const lead = envelopes[0]?.type === 'hello' ? String(envelopes[0].body?.device || '').slice(0, 128) : null;
        if (lead && headerDev && lead !== headerDev) return refuse('hello and header disagree', lead);
        const sender = lead || headerDev;
        // Nothing in a batch that does not name the bound device is acted on.
        if (!sender || (device.deviceId && sender !== device.deviceId)) return refuse(lead ? 'hello device' : 'header device', sender);
        if (!device.deviceId && !lead) return refuse('unbound, no hello', sender);
        return seal(await hub.handlePost(device, envelopes, sender));
      }
      if (p === '/textx/v1/messages' && method === 'GET') {
        if (!device.deviceId) return seal({ envelopes: [], cursor: '0' });
        if (askedDev !== device.deviceId) return refuse('?device');
        const first = await hub.drain(device, params.get('since'));
        // Long-poll: `wait` (seconds) holds an empty answer until something is queued. Capped at
        // LONG_POLL_MAX_S, under the api.lanagent.net relay's 30 s request ceiling.
        const wait = Math.min(LONG_POLL_MAX_S, Number.parseFloat(params.get('wait')) || 0);
        if (first.envelopes.length || !(wait > 0)) return seal(first);
        await hub.waitForOutbox(device.id, wait * 1000);
        return seal(await hub.drain(device, params.get('since')));
      }
      if ((p.startsWith('/textx/v1/files') || p === '/textx/v1/avatar') && (!device.deviceId || askedDev !== device.deviceId)) return refuse();
      if (p === '/textx/v1/files' && method === 'POST') {
        if (raw.length > MAX_FILE + 64) return json(413, { error: 'too large' });
        let data;
        try { data = openBytes(device.key, device.kid, P2A, raw); } catch { return json(400, { error: 'bad_frame' }); }
        const id = await saveFile(device, data, {});
        return seal({ url: fileUrl(device, id) });
      }
      const fm = /^\/textx\/v1\/files\/([A-Za-z0-9_-]+)$/.exec(p);
      if (fm && method === 'GET') {
        const data = await fs.readFile(filePath(device, fm[1])).catch(() => null);
        if (!data) return json(404, { error: 'no such file' });
        return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: sealBytes(device.key, device.kid, A2P, data) };
      }
      if (p === '/textx/v1/avatar' && method === 'GET') {
        const file = await avatarFile();
        const data = file ? await fs.readFile(file).catch(() => null) : null;
        if (!data) return json(404, { error: 'no avatar' });
        return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: sealBytes(device.key, device.kid, A2P, data) };
      }
      return json(404, { error: 'not found' });
    } catch (error) {
      logger.error?.(`TextX ${method} ${p} failed: ${error.message}`);
      return json(500, { error: 'internal' });
    }
  }

  /**
   * A phone's WebSocket. `send(text)` and `close(code, reason)` belong to whichever socket
   * carries it. Returns null for an unknown pairing (refuse with 401), else the session's
   * frame and close handlers.
   *
   * The socket is anonymous until its hello names the device the pairing is bound to (or binds
   * it). Only then is it attached to the hub, gets the outbox and is sent anything: a second
   * device holding the key never sees a frame and cannot replace the real phone's socket.
   */
  async function ws({ headers = {}, send, close }) {
    const device = await auth(headers);
    if (!device) return null;
    let bad = 0;
    let closed = false;
    let sender = null;   // the device this socket proved, once its hello was accepted
    let session = null;
    let sentAt = Date.now();
    const raw = (env) => { if (!closed) { sentAt = Date.now(); send(JSON.stringify(sealJson(device.key, device.kid, A2P, env))); } };
    const shut = (code, reason) => { if (!closed) { closed = true; close(code, reason); } };

    // A phone pings after 25 s of quiet and drops its side after 75 s; a phone that vanished (LTE gone, no
    // close) left ALICE "connected" and tool calls went into a dead socket until their read timeout. The
    // same rule here (as Orbit's bridge, 2026-10-26). A relayed socket's close does not reach onClose, so
    // the session is detached here too.
    // Only DATA frames count: a WebSocket ping control frame is answered below this layer (ws library,
    // relay). That closed live sockets on 2.25.658, so 2.25.659 turned this off; TextX 0.4.62 and
    // DialX 0.7.58 now send a `ping` envelope whenever they have sent nothing for 25 s (protocol §3.1),
    // so it is back on. socketSilentMs 0 turns it off.
    let heard = Date.now();
    const idle = socketSilentMs > 0 && setInterval(() => {
      if (closed) { clearInterval(idle); return; }
      if (Date.now() - heard <= socketSilentMs) return;
      clearInterval(idle);
      logger.info?.(`TextX: ${device.name} socket silent ${Math.round(socketSilentMs / 1000)} s; closing it`);
      shut(1001, 'silent');
      if (session) hub.detach(device, session);
    }, Math.min(15000, Math.max(10, Math.floor(socketSilentMs / 5))));
    if (idle) idle.unref?.();
    // A data ping after 30 s of ALICE sending nothing. A sleeping phone wakes on the packet and answers with a data
    // frame, which keeps it inside the 75 s silence rule. A WS-level ping is answered by the phone's socket library
    // (OkHttp in NotifX) without the app ever seeing it, so it kept nothing open (2026-10-26, 3051 #83).
    const keepAlive = setInterval(() => {
      if (closed) { clearInterval(keepAlive); return; }
      if (session && Date.now() - sentAt >= socketKeepAliveMs) raw(hub.envelope('ping'));
    }, Math.min(10000, Math.max(10, Math.floor(socketKeepAliveMs / 3))));
    keepAlive.unref?.();

    // Frames are handled in arrival order: a message sent right behind its hello must see the
    // pairing already bound.
    let queue = Promise.resolve();
    const handle = async (text) => {
      heard = Date.now();
      let env;
      try { env = openJson(device.key, device.kid, P2A, String(text)); } catch {
        if (++bad >= BAD_FRAMES_BEFORE_CLOSE) shut(4400, 'frames do not decrypt');
        return;
      }
      // The device record may have changed (a hello bound it): read it fresh per frame.
      const current = (await hub.deviceByKid(device.kid)) || device;
      if (!session) {
        if (env.type === 'ack' || env.type === 'pong') return;
        if (env.type !== 'hello') { raw(hub.envelope('error', { code: 'auth', message: 'send hello first' })); return; }
        const ok = await hub.receive(current, env, raw, null).catch(() => false);
        if (!ok) { shut(4401, 'pairing bound to another device'); return; }
        sender = String(env.body.device);
        session = await hub.attach(current, { send: raw, close: shut });
        return;
      }
      if (env.type === 'tool_result') logger.info?.(`TextX: tool_result ${env.body?.call_id} from ${current.name} over its socket`);
      await hub.onSocketEnvelope(current, env, sender).catch(e => logger.error?.(`TextX frame failed: ${e.message}`));
    };
    return {
      onMessage(text) {
        queue = queue.then(() => handle(text));
        return queue;
      },
      onClose() { closed = true; if (idle) clearInterval(idle); clearInterval(keepAlive); if (session) hub.detach(device, session); }
    };
  }

  /** Remove files older than the replay window. */
  async function sweepFiles(now = Date.now()) {
    const dirs = await fs.readdir(filesDir).catch(() => []);
    for (const d of dirs) {
      for (const f of await fs.readdir(path.join(filesDir, d)).catch(() => [])) {
        const full = path.join(filesDir, d, f);
        const st = await fs.stat(full).catch(() => null);
        if (st && now - st.mtimeMs > FILE_TTL_MS) await fs.unlink(full).catch(() => {});
      }
    }
  }

  return { http, ws, sweepFiles };
}

export default createTransport;
