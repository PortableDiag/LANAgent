import Transport from 'winston-transport';
import mongoose from 'mongoose';

/**
 * Writes warnings and errors into the SystemLog collection, so the agent (and the scheduler's
 * error and operations reports) can query its own recent history instead of grepping files.
 *
 * Until 2026-10-03 nothing wrote SystemLog: two scheduler reports counted from it and always
 * read zero. The collection is capped (100 MB / 100k documents, models/SystemLog.js), which is
 * the retention policy: at ~5,700 warnings and errors a day before flood collapsing, about a
 * month of history.
 *
 * Rules, because a log sink must never become the problem:
 * - never throws, never logs through winston (a failure here would loop); it reports its own
 *   trouble to stderr at most once every 5 minutes;
 * - batches inserts (every 2 s or 50 entries), and holds entries while Mongo is not connected,
 *   bounded at 1,000 (oldest dropped, the drop count recorded in the next entry);
 * - collapses floods: the same message more than 3 times in a minute is counted, not stored,
 *   and one summary entry records how many were folded;
 * - stores what the log files already show, redacted by the same formats (logger.js).
 *
 * Level: SYSTEMLOG_LEVEL (default warn). An info entry is stored too when it names a category
 * ({ category: 'performance' } etc.) or sets { systemLog: true }. SYSTEMLOG_DISABLED=true
 * turns it off.
 */

export const CATEGORIES = ['system', 'task', 'network', 'security', 'ai', 'user', 'performance', 'update'];
const LEVELS = { error: 'error', warn: 'warn', info: 'info', debug: 'debug', verbose: 'debug', silly: 'trace', http: 'info' };
const SKIP_KEYS = new Set(['level', 'message', 'timestamp', 'service', 'stack', 'category', 'systemLog', 'tags', 'splat']);
const FLOOD_LIMIT = 3;
const FLOOD_WINDOW_MS = 60_000;
const MAX_BUFFER = 1000;
const MAX_MESSAGE = 2000;
const MAX_DETAILS = 4000;

/** Which SystemLog category an entry belongs to, from its service and wording. */
export function categorize(service = '', message = '') {
  const s = String(service).toLowerCase();
  const m = String(message);
  if (/self-?mod|update|deploy/.test(s)) return 'update';
  if (/unauthori[sz]ed|forbidden|\bauth(entication)? fail|denied|ssrf|csrf|blocked request|invalid (api )?key|signature/i.test(m)) return 'security';
  if (/ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|\bDNS\b|\b5\d\d\b.*(upstream|gateway)|timeout of \d+ms/i.test(m)) return 'network';
  // "provider" alone is not enough: "oauthmanager: no providers configured" is not an AI failure.
  if (/\bAI provider|openrouter|anthropic|openai|huggingface|\bLLM\b|\bmodel\b|tokens?\b.*(limit|context)|completion/i.test(m)) return 'ai';
  if (/\btask\b|agenda|job\b|scheduled/i.test(m)) return 'task';
  if (/response time|latency|slow|memory|cpu|load average/i.test(m)) return 'performance';
  return 'system';
}

const stripAnsi = (t) => String(t).replace(/\x1b\[[0-9;]*m/g, '');
const floodKey = (level, service, message) => `${level}|${service}|${stripAnsi(message).replace(/\d+/g, '#').slice(0, 160)}`;

export class SystemLogTransport extends Transport {
  constructor(opts = {}) {
    super({ ...opts, level: undefined });
    // The transport filters by itself: a plain winston level would drop opted-in info entries.
    this.minLevel = opts.level || process.env.SYSTEMLOG_LEVEL || 'warn';
    this.buffer = [];
    this.dropped = 0;
    this.floods = new Map();          // key -> { first, count, suppressed, sample }
    this.flushEvery = opts.flushMs ?? 2000;
    this.batchSize = opts.batchSize ?? 50;
    this.getModel = opts.getModel || (async () => (await import('../models/SystemLog.js')).SystemLog);
    this.isConnected = opts.isConnected || (() => mongoose.connection.readyState === 1);
    this.now = opts.now || (() => Date.now());
    this.lastComplaint = 0;
    this.flushing = false;
    if (this.flushEvery > 0) {
      this.timer = setInterval(() => { this.flush().catch(() => {}); }, this.flushEvery);
      this.timer.unref?.();
    }
  }

  wants(info) {
    const order = { error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6 };
    const lvl = order[info.level] ?? 2;
    if (lvl <= (order[this.minLevel] ?? 1)) return true;
    return info.systemLog === true || (lvl <= order.info && CATEGORIES.includes(info.category));
  }

  log(info, callback) {
    try {
      if (this.wants(info)) this.accept(info);
    } catch (e) {
      this.complain(`could not queue a log entry: ${e.message}`);
    }
    callback?.();
  }

  accept(info) {
    const level = LEVELS[info.level] || 'info';
    const service = info.service || 'lan-agent';
    const message = stripAnsi(typeof info.message === 'string' ? info.message : JSON.stringify(info.message ?? ''));
    const now = this.now();

    // Flood collapsing: count repeats inside the window instead of storing each one.
    const key = floodKey(level, service, message);
    const f = this.floods.get(key);
    if (f && now - f.first < FLOOD_WINDOW_MS) {
      f.count++;
      if (f.count > FLOOD_LIMIT) { f.suppressed++; return; }
    } else {
      if (f?.suppressed) this.push(this.summary(f));
      this.floods.set(key, { first: now, count: 1, suppressed: 0, level, service, message });
    }

    const details = {};
    for (const [k, v] of Object.entries(info)) {
      if (SKIP_KEYS.has(k) || typeof k === 'symbol') continue;
      details[k] = v;
    }
    let detailsOut;
    if (Object.keys(details).length) {
      const text = safeJson(details);
      detailsOut = text.length > MAX_DETAILS ? { truncated: text.slice(0, MAX_DETAILS) } : JSON.parse(text);
    }
    const doc = {
      level,
      category: CATEGORIES.includes(info.category) ? info.category : categorize(service, message),
      message: message.slice(0, MAX_MESSAGE) || '(empty message)',
      ...(detailsOut ? { details: detailsOut } : {}),
      source: { service },
      tags: [service, ...(Array.isArray(info.tags) ? info.tags.slice(0, 5).map(String) : [])],
      createdAt: new Date(now)
    };
    if (info.stack || level === 'error') {
      const firstLine = message.split('\n')[0];
      doc.error = {
        message: firstLine.slice(0, 500),
        ...(info.stack ? { stack: String(info.stack).slice(0, 4000) } : {}),
        ...(info.code ? { code: String(info.code) } : {}),
        ...(info.name ? { name: String(info.name) } : {})
      };
    }
    this.push(doc);
  }

  summary(f) {
    return {
      level: f.level,
      category: categorize(f.service, f.message),
      message: `${f.message.slice(0, 1500)} (repeated ${f.suppressed} more time${f.suppressed === 1 ? '' : 's'} within a minute; not stored individually)`,
      details: { suppressed: f.suppressed },
      source: { service: f.service },
      tags: [f.service, 'flood-summary'],
      createdAt: new Date(this.now())
    };
  }

  push(doc) {
    this.buffer.push(doc);
    if (this.buffer.length > MAX_BUFFER) {
      this.dropped += this.buffer.length - MAX_BUFFER;
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    }
    if (this.buffer.length >= this.batchSize) this.flush().catch(() => {});
  }

  /** Write what is queued. Returns the number of documents stored. */
  async flush() {
    // Close flood windows that have ended, so a summary is written even if the message stops.
    const now = this.now();
    for (const [key, f] of this.floods) {
      if (now - f.first >= FLOOD_WINDOW_MS) {
        if (f.suppressed) this.buffer.push(this.summary(f));
        this.floods.delete(key);
      }
    }
    if (this.flushing || !this.buffer.length || !this.isConnected()) return 0;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.batchSize * 4);
    if (this.dropped) {
      batch.push({ level: 'warn', category: 'system', message: `System log sink dropped ${this.dropped} entries while the database was unavailable`, source: { service: 'system-log' }, tags: ['system-log'], createdAt: new Date(now) });
      this.dropped = 0;
    }
    try {
      const Model = await this.getModel();
      // Not lean: the schema defaults matter (findErrors() matches resolved.status === false).
      await Model.insertMany(batch, { ordered: false });
      return batch.length;
    } catch (e) {
      // Keep the batch for the next try unless it is the documents themselves that are bad.
      if (!e?.writeErrors && !/validation/i.test(e?.message || '')) this.buffer.unshift(...batch.slice(0, MAX_BUFFER - this.buffer.length));
      this.complain(`could not store log entries: ${e.message}`);
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  complain(text) {
    const now = this.now();
    if (now - this.lastComplaint < 5 * 60_000) return;
    this.lastComplaint = now;
    try { process.stderr.write(`[system-log] ${text}\n`); } catch { /* nothing left to do */ }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
  }
}

function safeJson(v) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(v, (k, x) => {
      if (typeof x === 'bigint') return x.toString();
      if (x && typeof x === 'object') { if (seen.has(x)) return '[circular]'; seen.add(x); }
      return x;
    }) ?? '{}';
  } catch { return '{}'; }
}
