/**
 * Live puppeting (Bots & Borgs 0.57, llms.txt "Live puppeting"): the agent streams small pose commands over one
 * WebSocket and each viewer page solves them on the avatar every frame (median 32 ms end to end).
 *
 * - The owner's own pages (the live 3D page, the LANAgent app) watch the stream "owner" on the body the agent wears:
 *   that can be the personal avatar, which only the owner ever sees (the owner, 2026-11-20), so no other audience is
 *   ever given that stream or a token for it.
 * - The agent's account key stays here. A page gets a viewer token (bound to one body) and sends it as its first frame.
 * - Commands are JSON, every field optional; at most 4 KB each and 30 a second per stream.
 */
import WebSocket from 'ws';
import { logger } from '../../utils/logger.js';

export const PUPPET_WS = 'wss://botsandborgs.com/api/puppet/ws';
export const OWNER_STREAM = 'owner';
const MAX_BYTES = 4096;
const MIN_GAP_MS = 1000 / 30;
const IDLE_CLOSE_MS = 10 * 60 * 1000;

/** The named poses the runtime knows (bnb-puppet 1.0.0). */
export const POSES = ['wave', 'point', 'thumbs_up', 'shrug', 'think', 'cheer', 'bow'];

/** A command trimmed to the fields the runtime knows, or null when it is empty or too big. */
export function cleanCommand(cmd) {
  const KNOWN = new Set(['hands', 'point_at', 'gaze', 'head', 'lean', 'mood', 'expression', 'visemes', 'level', 'pose', 'clip',
    'keys', 'ease', 'duration', 'weight', 'hold', 'release', 'end']);
  if (!cmd || typeof cmd !== 'object') return null;
  const out = Object.fromEntries(Object.entries(cmd).filter(([k, v]) => KNOWN.has(k) && v !== undefined));
  if (out.pose && !POSES.includes(String(out.pose))) delete out.pose;
  if (!Object.keys(out).length) return null;
  return JSON.stringify(out).length <= MAX_BYTES ? out : null;
}

/** Same body, same stream: the same publisher (a body is { live } | { product } | { link, model, outfit } | { locker }). */
export const bodyKey = (avatar, stream = OWNER_STREAM) => `${stream}|${JSON.stringify(avatar)}`;

/**
 * One publishing socket for one body and stream: authenticated on open ({auth, avatar, stream} → {ready}), commands
 * throttled to 30 a second (the latest wins), reconnecting with back-off, closed after 10 idle minutes.
 */
export class PuppetPublisher {
  constructor({ key, avatar, stream = OWNER_STREAM, url = PUPPET_WS, WebSocketImpl = WebSocket, log = logger } = {}) {
    Object.assign(this, { key, avatar, stream, url, WS: WebSocketImpl, log });
    this.ws = null; this.ready = false; this.pending = null; this.lastSent = 0; this.timer = null; this.closed = false;
    this.wait = 1000; this.idle = null; this.viewers = 0; this.sha = null;
  }

  open() {
    if (this.closed || this.ws) return;
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ auth: this.key, avatar: this.avatar, stream: this.stream })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.ready) {
        this.ready = true; this.wait = 1000; this.viewers = m.ready.viewers ?? 0; this.sha = m.ready.vrm_sha256 || null;
        this.log.info?.(`Puppet: streaming "${this.stream}" (${this.viewers} viewer${this.viewers === 1 ? '' : 's'})`);
        this.flush();
      } else if (m.error) {
        this.log.warn?.(`Puppet: ${m.error}${m.line ? `: ${m.line}` : ''}`);
        if (m.error === 'unauthorized') this.close();
      } else if (m.end === true && m.reason) {
        this.log.info?.(`Puppet: stream ended (${m.reason})`);
        this.close();
      }
    });
    ws.on('close', () => {
      this.ws = null; this.ready = false;
      if (!this.closed) setTimeout(() => this.open(), this.wait).unref?.();
      this.wait = Math.min(this.wait * 2, 30000);
    });
    ws.on('error', (e) => this.log.warn?.(`Puppet: socket error: ${e.message}`));
  }

  /** Queue a command; the latest one goes out as soon as the socket is ready and the 30-a-second gap allows. */
  send(cmd) {
    const c = cleanCommand(cmd);
    if (!c) return false;
    this.pending = this.pending ? { ...this.pending, ...c } : c;
    this.touch();
    this.open();
    this.flush();
    return true;
  }

  flush() {
    if (!this.ready || !this.pending || !this.ws) return;
    const wait = this.lastSent + MIN_GAP_MS - Date.now();
    if (wait > 0) { if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait); return; }
    const out = this.pending; this.pending = null;
    this.ws.send(JSON.stringify(out));
    this.lastSent = Date.now();
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    this.idle.unref?.();
  }

  close() {
    this.closed = true; this.ready = false;
    clearTimeout(this.idle); clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}
