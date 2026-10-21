import crypto from 'node:crypto';
import WebSocket from 'ws';

/**
 * Dials out to the TextX relay (api.lanagent.net) so a paired phone reaches this agent from
 * anywhere without an open port. Link spec: Trellis "LANAgent Ecosystem › Agent Card" #79,
 * mirrored in docs/TEXTX.md.
 *
 * The relay knows this instance only by its P2P Ed25519 fingerprint and forwards
 * `/r/<fp>/textx/v1/*` here as `req` (HTTP) and `open`/`msg`/`close` (WebSocket) frames.
 * Everything inside is end-to-end sealed (textxCrypto.js), so the relay routes and never reads.
 */

export const DEFAULT_RELAY_URL = 'wss://api.lanagent.net/textx/relay/agent';
const SIG_PREFIX = 'textx-relay-v1';

export function relaySignature(signPrivateKeyDer, relay, nonce) {
  const key = crypto.createPrivateKey({ key: Buffer.from(signPrivateKeyDer), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(`${SIG_PREFIX}|${relay}|${nonce}`, 'utf8'), key).toString('base64');
}

export class TextXRelayClient {
  /**
   * @param {object} o
   * @param {object} o.transport  createTransport() result: { http, ws }
   * @param {function} o.identity async () => { signPublicKey: Buffer(DER), signPrivateKey: Buffer(DER), fingerprint }
   */
  constructor({ transport, identity, url = DEFAULT_RELAY_URL, connectAddress = null, logger = console, WebSocketImpl = WebSocket, pingMs = 30_000 } = {}) {
    this.transport = transport;
    this.identity = identity;
    this.url = url;
    // Dial this IP instead of the relay's DNS address, keeping its hostname for TLS. For a host
    // whose firewall only lets traffic out through a tunnel (a VPN kill switch).
    this.connectAddress = connectAddress;
    this.logger = logger;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.base = null;
    this.ready = false;
    this.stopped = true;
    this.delay = 1000;
    this.sessions = new Map(); // sid -> handlers from transport.ws()
    // Our own liveness check. The relay terminates a link that misses its pings, but when the
    // path is what broke, that close never arrives: on 2026-10-21 the relay dropped the link at
    // 10:49 and the socket here stayed ESTABLISHED and "up" for hours, so no phone could reach us.
    this.pingMs = pingMs;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    try { this.socket?.close(1000, 'stopping'); } catch { /* closed */ }
  }

  status() { return { url: this.url, connected: this.ready, base: this.base }; }

  connect() {
    if (this.stopped) return;
    let ws;
    try {
      const opts = { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 15000 };
      if (this.connectAddress) {
        const address = this.connectAddress;
        const family = address.includes(':') ? 6 : 4;
        opts.lookup = (host, o, cb) => (o?.all ? cb(null, [{ address, family }]) : cb(null, address, family));
      }
      ws = new this.WebSocketImpl(this.url, opts);
    } catch (e) {
      return this.retry(e);
    }
    this.socket = ws;
    let alive = true;
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.socket !== ws || ws.readyState !== 1) return;
      if (!alive) {
        this.logger.warn?.('TextX relay link stopped answering; reconnecting');
        ws.terminate?.();
        return;
      }
      alive = false;
      try { ws.ping?.(); } catch { /* closing */ }
    }, this.pingMs);
    this.pingTimer.unref?.();
    ws.on('pong', () => { alive = true; });
    ws.on('message', (data) => {
      alive = true;
      this.onFrame(String(data)).catch(e => this.logger.error?.(`TextX relay frame failed: ${e.message}`));
    });
    ws.on('close', (code) => {
      if (this.socket !== ws) return;
      clearInterval(this.pingTimer);
      const wasReady = this.ready;
      this.ready = false;
      for (const s of this.sessions.values()) s.onClose();
      this.sessions.clear();
      if (wasReady) this.logger.warn?.(`TextX relay link closed (${code}); reconnecting`);
      if (code === 4000) this.logger.warn?.('TextX relay: another link with this identity replaced ours');
      this.retry(wasReady ? null : this.lastError);
      this.lastError = null;
    });
    ws.on('error', (e) => { if (!this.ready) this.lastError = e; this.logger.debug?.(`TextX relay socket error: ${e.message}`); });
  }

  retry(error) {
    if (this.stopped) return;
    // Visible, but once per 10 minutes: a refused link is otherwise a silent "connecting" forever.
    if (error && Date.now() - (this.warnedAt || 0) > 600_000) {
      this.warnedAt = Date.now();
      this.logger.warn?.(`TextX relay unreachable (${this.url}): ${error.message}. Phones cannot reach this agent from outside its network until it connects.`);
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.delay * (0.75 + Math.random() / 2));
    this.delay = Math.min(this.delay * 2, 60_000);
  }

  send(obj) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(obj));
  }

  async onFrame(text) {
    let f;
    try { f = JSON.parse(text); } catch { return; }
    switch (f.t) {
      case 'challenge': {
        const id = await this.identity();
        this.send({ t: 'auth', pub: Buffer.from(id.signPublicKey).toString('base64'), sig: relaySignature(id.signPrivateKey, f.relay, f.nonce) });
        return;
      }
      case 'ready':
        this.ready = true;
        this.base = f.base;
        this.delay = 1000;
        this.logger.info?.(`TextX relay link up: ${f.base}`);
        return;
      case 'req': {
        const res = await this.transport.http({
          method: f.method, path: f.path, query: f.query || '', headers: f.headers || {},
          body: f.body ? Buffer.from(f.body, 'base64') : null
        });
        this.send({ t: 'res', rid: f.rid, status: res.status, headers: res.headers, body: res.body?.length ? res.body.toString('base64') : null });
        return;
      }
      case 'open': {
        if (f.path !== '/textx/v1/ws') { this.send({ t: 'reject', sid: f.sid, status: 404 }); return; }
        // Attaching resends the outbox at once; hold those frames until the relay has the accept.
        let held = [];
        const handlers = await this.transport.ws({
          headers: f.headers || {},
          send: (data) => (held ? held.push(data) : this.send({ t: 'msg', sid: f.sid, data })),
          close: (code, reason) => { this.sessions.delete(f.sid); this.send({ t: 'close', sid: f.sid, code, reason }); }
        });
        if (!handlers) { this.send({ t: 'reject', sid: f.sid, status: 401 }); return; }
        this.sessions.set(f.sid, handlers);
        this.send({ t: 'accept', sid: f.sid });
        const queued = held;
        held = null;
        for (const data of queued) this.send({ t: 'msg', sid: f.sid, data });
        return;
      }
      case 'msg':
        await this.sessions.get(f.sid)?.onMessage(f.data);
        return;
      case 'close': {
        const s = this.sessions.get(f.sid);
        this.sessions.delete(f.sid);
        s?.onClose();
        return;
      }
    }
  }
}

export default TextXRelayClient;
