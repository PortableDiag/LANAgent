/**
 * Trellis agent event stream client (`GET /api/agent/stream`, relay 2754 #303–#321).
 *
 * One server-sent-events connection per key, across every document it reaches, replacing the
 * inbox long-poll. Agreed v1: envelope {v, type, id, at, document?, card?, data}, `data` being
 * the row a read returns; at-least-once delivery (drop duplicate ids); `Last-Event-ID` resumes;
 * `POST /api/agent/stream/ack {cursor}` stores the read point; `reset` / `replaced` / `auth`
 * end the stream. Unknown types and fields are ignored.
 *
 * Here the stream is only the wake-up, like the inbox: a message still goes through the
 * listener's _handleChannel, which reads the channel and applies the operator-trust rule. A
 * server without the route answers 404, and the listener stays on the inbox and asks again
 * later, so this switches over by itself when each server ships it.
 */
import axios from 'axios';
import { logger } from '../../utils/logger.js';

export const STREAM_TYPES = ['message', 'signoff_requested', 'hello', 'reset', 'replaced', 'auth', 'access'];
const ACK_EVERY_MS = 30000;
const IDLE_LIMIT_MS = 60000;      // keep-alives come every 15 s; a minute of nothing is a dead stream
const SEEN_MAX = 2000;

/** Split an SSE byte stream into events: {event, id, data} per blank-line-terminated block. */
export class SseParser {
  constructor(onEvent) { this.buf = ''; this.onEvent = onEvent; }
  push(chunk) {
    this.buf += chunk.toString('utf8').replace(/\r\n/g, '\n');
    let i;
    while ((i = this.buf.indexOf('\n\n')) !== -1) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const ev = { event: 'message', id: null, data: '' };
      const data = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;               // keep-alive comment
        const c = line.indexOf(':');
        const field = c === -1 ? line : line.slice(0, c);
        const value = c === -1 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (field === 'event') ev.event = value;
        else if (field === 'id') ev.id = value;
        else if (field === 'data') data.push(value);
      }
      if (!data.length && !ev.id) continue;
      ev.data = data.join('\n');
      this.onEvent(ev);
    }
  }
}

export class TrellisStream {
  /**
   * @param {object} p
   * @param {object} p.plugin - trellis-notes (base URL, key, agent name)
   * @param {(env: object) => Promise<void>} p.onEvent - an envelope {type, id, document, card, data}
   */
  constructor({ plugin, onEvent }) {
    this.plugin = plugin;
    this.onEvent = onEvent;
    this.cursor = null;
    this.seen = new Set();
    this.available = null;          // null unknown, false not served (404), true served
  }

  /**
   * Run one connection until it ends. Resolves to why: 'unavailable' (the server has no
   * stream), 'closed' / 'idle' / 'error' (reconnect later), or 'reset' / 'replaced' / 'auth'.
   */
  async run() {
    await this.plugin._ensureTarget();
    const controller = new AbortController();
    let res;
    try {
      res = await axios.get(`${this.plugin._base()}/api/agent/stream`, {
        params: { types: STREAM_TYPES.join(',') },
        responseType: 'stream',
        signal: controller.signal,
        timeout: 20000,
        validateStatus: () => true,
        headers: {
          Accept: 'text/event-stream',
          'X-API-Key': this.plugin.credentials?.apiKey,
          'X-Agent': this.plugin._agentName(),
          ...(this.cursor ? { 'Last-Event-ID': this.cursor } : {})
        }
      });
    } catch (err) {
      return 'error';
    }
    if ([404, 405, 501].includes(res.status)) {
      res.data?.destroy?.();
      this.available = false;
      return 'unavailable';
    }
    if (res.status === 401 || res.status === 403) { res.data?.destroy?.(); return 'auth'; }
    if (res.status >= 400) { res.data?.destroy?.(); return 'error'; }
    this.available = true;
    logger.info('[trellis-stream] connected to the agent event stream');

    return await new Promise((resolve) => {
      let done = false;
      let lastByte = Date.now();
      let acked = this.cursor;
      const finish = (why) => {
        if (done) return;
        done = true;
        clearInterval(ackTimer); clearInterval(idleTimer);
        controller.abort();
        res.data?.destroy?.();
        this._ack().catch(() => {});
        resolve(why);
      };
      const ackTimer = setInterval(() => {
        if (this.cursor && this.cursor !== acked) { acked = this.cursor; this._ack().catch(() => {}); }
      }, ACK_EVERY_MS);
      const idleTimer = setInterval(() => { if (Date.now() - lastByte > IDLE_LIMIT_MS) finish('idle'); }, 5000);
      ackTimer.unref?.(); idleTimer.unref?.();

      let chain = Promise.resolve();
      const parser = new SseParser((ev) => {
        chain = chain.then(() => this._dispatch(ev)).then((end) => { if (end) finish(end); })
          .catch(err => logger.warn(`[trellis-stream] event failed: ${err.message}`));
      });
      res.data.on('data', (chunk) => { lastByte = Date.now(); parser.push(chunk); });
      // Let queued events finish first: a server that sends `reset` and closes at once must end
      // the stream as a reset (with its cursor), not as a plain close.
      res.data.on('end', () => { chain.then(() => finish('closed')); });
      res.data.on('error', () => { chain.then(() => finish('error')); });
    });
  }

  /** Handle one SSE event. Returns a reason to end the stream, or null. */
  async _dispatch(ev) {
    let env = null;
    try { env = ev.data ? JSON.parse(ev.data) : {}; } catch { return null; }
    const type = env.type || ev.event;
    const id = env.id || ev.id;
    if (id) {
      if (this.seen.has(id)) return null;              // at-least-once: drop a repeat
      this.seen.add(id);
      if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value);
    }
    if (type === 'hello') {
      if (env.data?.cursor && !this.cursor) this.cursor = env.data.cursor;
      return null;
    }
    if (type === 'reset') { this.cursor = env.data?.cursor || null; return 'reset'; }
    if (type === 'replaced') return 'replaced';
    if (type === 'auth') return 'auth';
    await this.onEvent({ type, id, document: env.document || null, card: env.card ?? env.data?.card ?? null, data: env.data || {} });
    if (id) this.cursor = id;
    return null;
  }

  async _ack() {
    if (!this.cursor) return;
    await axios.post(`${this.plugin._base()}/api/agent/stream/ack`, { cursor: this.cursor }, {
      timeout: 10000,
      validateStatus: () => true,
      headers: { 'X-API-Key': this.plugin.credentials?.apiKey, 'X-Agent': this.plugin._agentName(), 'Content-Type': 'application/json' }
    });
  }
}
