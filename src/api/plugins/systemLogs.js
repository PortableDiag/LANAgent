import { BasePlugin } from '../core/basePlugin.js';
import { extractParams } from '../../services/webtools/extractParams.js';
import { SystemLog } from '../../models/SystemLog.js';
import { CATEGORIES } from '../../utils/systemLogTransport.js';

/**
 * The agent's own recent warnings and errors, from the SystemLog collection that the logger
 * fills (utils/systemLogTransport.js). Read-only. Answers "what went wrong in the last hour",
 * "search the logs for X", "what keeps failing" without anyone reading log files.
 *
 * Kept from other agents (reasoning/toolCatalog.js PEER_EXCLUDED): logs describe this host.
 */
const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default class SystemLogsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'systemLogs';
    this.version = '1.0.0';
    this.description = "Read this agent's own recent warnings and errors: list them, search them, and summarise what keeps failing";
    this.commands = [
      { command: 'recent', description: 'List recent warnings and errors, newest first, optionally only one level, category or service',
        usage: 'recent({ level: "error", category: "network", service: "crypto", hours: 6, limit: 20 })',
        examples: ['show recent errors', 'what went wrong in the last hour', 'any warnings from the crypto service today', 'list the latest network errors'] },
      { command: 'search', description: 'Search the stored warnings and errors for words or a phrase',
        usage: 'search({ query: "timeout", hours: 72, level: "error", limit: 20 })',
        examples: ['search the logs for timeout', 'did anything mention openrouter in the logs', 'find log entries about the VPN'] },
      { command: 'summary', description: 'Summarise warnings and errors over a period: counts by level, category and service, and the messages that repeat most',
        usage: 'summary({ hours: 24 })',
        examples: ['what keeps failing', 'summarise the errors from today', 'how many errors in the last 24 hours'] },
      { command: 'entry', description: 'Show one stored log entry in full, with its details and stack trace',
        usage: 'entry({ id: "<entry id from recent or search>" })',
        examples: ['show the full log entry 6ac1...'] }
    ];
    this.model = SystemLog;
  }

  async execute(params = {}) {
    const { action, ...p } = await extractParams(this, params.action, params);
    try {
      switch (action) {
        case 'recent': return await this.recent(p);
        case 'search': return await this.search(p);
        case 'summary': return await this.summary(p);
        case 'entry': return await this.entry(p);
        default: return { success: false, error: `Unknown action '${action}'. Use: recent, search, summary, entry` };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  filter({ level, category, service, hours }, dfltHours = 24) {
    const q = { createdAt: { $gte: new Date(Date.now() - clampInt(hours, 1, 720, dfltHours) * 3600_000) } };
    if (level) {
      const l = String(level).toLowerCase().replace(/s$/, '').replace(/^warning$/, 'warn');
      if (!LEVELS.includes(l)) throw new Error(`level must be one of: ${LEVELS.join(', ')}`);
      q.level = l;
    }
    if (category) {
      const c = String(category).toLowerCase();
      if (!CATEGORIES.includes(c)) throw new Error(`category must be one of: ${CATEGORIES.join(', ')}`);
      q.category = c;
    }
    if (service) q['source.service'] = new RegExp(`^${escapeRe(String(service).slice(0, 60))}`, 'i');
    return q;
  }

  line(e) {
    const t = new Date(e.createdAt).toISOString().replace('T', ' ').slice(0, 19);
    const svc = e.source?.service && e.source.service !== 'lan-agent' ? ` [${e.source.service}]` : '';
    return `${t} UTC ${String(e.level).toUpperCase()}${svc} ${String(e.message).slice(0, 300)} (id ${e._id})`;
  }

  async recent(p) {
    const limit = clampInt(p.limit, 1, 100, 20);
    const q = this.filter(p, 24);
    const rows = await this.model.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    const what = [p.level, p.category, p.service].filter(Boolean).join(' ') || 'warnings and errors';
    return {
      success: true,
      count: rows.length,
      entries: rows.map(r => ({ id: String(r._id), at: r.createdAt, level: r.level, category: r.category, service: r.source?.service, message: r.message })),
      result: rows.length ? rows.map(r => this.line(r)).join('\n') : `No ${what} stored for that period.`
    };
  }

  async search(p) {
    const query = String(p.query || p.text || '').trim();
    if (!query) throw new Error('a query is required, e.g. search({ query: "timeout" })');
    const limit = clampInt(p.limit, 1, 100, 20);
    const base = this.filter(p, 72);
    // Words via the text index; a phrase with symbols (an address, a URL) via a literal match.
    const literal = /[^\w\s-]/.test(query) || query.length < 3;
    const q = literal
      ? { ...base, $or: [{ message: new RegExp(escapeRe(query.slice(0, 200)), 'i') }, { 'error.message': new RegExp(escapeRe(query.slice(0, 200)), 'i') }] }
      : { ...base, $text: { $search: query.slice(0, 200) } };
    const rows = await this.model.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    return {
      success: true,
      count: rows.length,
      entries: rows.map(r => ({ id: String(r._id), at: r.createdAt, level: r.level, service: r.source?.service, message: r.message })),
      result: rows.length ? rows.map(r => this.line(r)).join('\n') : `Nothing in the stored warnings and errors matches "${query}".`
    };
  }

  async summary(p) {
    const hours = clampInt(p.hours, 1, 720, 24);
    const match = this.filter({ hours }, 24);
    const [byLevel, byCategory, byService, repeats] = await Promise.all([
      this.model.aggregate([{ $match: match }, { $group: { _id: '$level', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      this.model.aggregate([{ $match: match }, { $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      this.model.aggregate([{ $match: match }, { $group: { _id: '$source.service', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]),
      // Messages that repeat: the first 80 characters, plus what flood collapsing folded away.
      this.model.aggregate([
        { $match: match },
        { $group: { _id: { level: '$level', m: { $substrCP: ['$message', 0, 80] } }, n: { $sum: { $add: [1, { $ifNull: ['$details.suppressed', 0] }] } }, last: { $max: '$createdAt' } } },
        { $sort: { n: -1 } }, { $limit: 8 }
      ])
    ]);
    const total = byLevel.reduce((a, r) => a + r.n, 0);
    const fmt = (rows) => rows.map(r => `${r._id || 'unknown'} ${r.n}`).join(', ');
    const lines = total
      ? [
        `${total} stored warnings and errors in the last ${hours} h (${fmt(byLevel)}).`,
        `By category: ${fmt(byCategory)}.`,
        `By service: ${fmt(byService)}.`,
        'Most repeated:',
        ...repeats.map(r => `- ${r.n}× ${String(r._id.level).toUpperCase()} ${r._id.m}${r._id.m.length >= 80 ? '…' : ''}`)
      ]
      : [`No warnings or errors stored in the last ${hours} h.`];
    return {
      success: true,
      hours,
      total,
      byLevel: Object.fromEntries(byLevel.map(r => [r._id, r.n])),
      byCategory: Object.fromEntries(byCategory.map(r => [r._id, r.n])),
      byService: Object.fromEntries(byService.map(r => [r._id || 'unknown', r.n])),
      topRepeated: repeats.map(r => ({ level: r._id.level, message: r._id.m, count: r.n, last: r.last })),
      result: lines.join('\n')
    };
  }

  async entry(p) {
    const id = String(p.id || '').trim();
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error('id must be the 24-character entry id that recent or search shows');
    const e = await this.model.findById(id).lean();
    if (!e) return { success: false, error: 'No stored log entry with that id (old entries roll off as the log fills).' };
    const parts = [this.line(e), `category: ${e.category}`];
    if (e.details) parts.push(`details: ${JSON.stringify(e.details).slice(0, 1500)}`);
    if (e.error?.stack) parts.push(`stack:\n${e.error.stack.slice(0, 2500)}`);
    return { success: true, entry: e, result: parts.join('\n') };
  }
}
