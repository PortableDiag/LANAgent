/**
 * The operator profile — a short curated note about who the operator is and how they like
 * things done (after hermes-agent's USER.md). It goes into the system prompt as a FROZEN
 * snapshot: taken at start-up and refreshed at most once a day by tidy(), so the prompt
 * prefix — and the provider's prompt cache — stays stable between refreshes.
 *
 * Lines come from the background review, the operator (web UI / chat), and a one-time seed from
 * the facts memory already holds (category master_*). Every change is appended to a history.
 */
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { DATA_PATH } from '../../utils/paths.js';
import { sanitizeString } from '../p2p/sanitizer.js';

export const PROFILE_FILE = process.env.USER_PROFILE_PATH || path.join(DATA_PATH, 'agent', 'USER.md');
const MAX_CHARS = Number(process.env.USER_PROFILE_MAX_CHARS) || 2000;
const TIDY_TARGET = 1400;
const SECRETISH = /\b(sk-[A-Za-z0-9_-]{16,}|gsk_[0-9a-f]{16,}|dry_pat_\S+|tk_\S{20,}|0x[0-9a-fA-F]{64}|password\s*[:=]|api[_ -]?key\s*[:=])/i;
const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'than', 'rather', 'operator', 'operators', 'user', 'prefers', 'prefer', 'likes', 'wants']);
const words = (t) => new Set(norm(t).split(' ').filter(w => w.length > 2 && !STOP.has(w)));
/** Same meaning in other words: most of the shorter line's words appear in the other. */
export function nearDuplicate(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size) >= 0.7;
}

export class UserProfile {
  constructor({ file = PROFILE_FILE } = {}) {
    this.file = file;
    this.snapshotText = null;
    this.snapshotAt = 0;
    this._chain = Promise.resolve();
  }

  async text() {
    try { return (await fs.readFile(this.file, 'utf8')).trim(); } catch { return ''; }
  }

  /** The text as it was last frozen for the system prompt (read once, then held). */
  async snapshot() {
    if (this.snapshotText === null) { this.snapshotText = await this.text(); this.snapshotAt = Date.now(); }
    return this.snapshotText;
  }

  /** Refresh the frozen prompt copy (tidy and explicit edits call this; nothing else does). */
  async refreshSnapshot() {
    this.snapshotText = await this.text();
    this.snapshotAt = Date.now();
    return this.snapshotText;
  }

  _serial(fn) {
    this._chain = this._chain.then(fn, fn);
    return this._chain;
  }

  async _write(next, { source, action }) {
    const before = await this.text();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, next.trim() + '\n', 'utf8');
    await fs.rename(tmp, this.file);
    await fs.appendFile(`${this.file}.history.jsonl`, JSON.stringify({ at: new Date().toISOString(), source, action, before, after: next.trim() }) + '\n', 'utf8');
  }

  /** Add bullet lines (deduplicated, secret-looking lines refused). Returns the lines added. */
  add(lines, source = 'operator') {
    return this._serial(async () => {
      const current = await this.text();
      const existing = current.split('\n').map(l => l.replace(/^[-*]\s*/, '')).filter(Boolean);
      const have = new Set(existing.map(norm));
      const added = [];
      for (const raw of lines || []) {
        const line = sanitizeString(String(raw)).replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!line || SECRETISH.test(line) || have.has(norm(line))) continue;
        if (existing.some(e => nearDuplicate(e, line)) || added.some(e => nearDuplicate(e, line))) continue;
        have.add(norm(line));
        added.push(line);
      }
      if (!added.length) return [];
      const next = `${current}${current ? '\n' : ''}${added.map(l => `- ${l}`).join('\n')}`;
      await this._write(next, { source, action: 'add' });
      logger.info(`[profile] +${added.length} line(s) from ${source}`);
      return added;
    });
  }

  /** Replace the whole profile (the operator editing it). */
  set(text, source = 'operator') {
    return this._serial(async () => {
      const next = sanitizeString(String(text || '')).slice(0, MAX_CHARS * 2);
      await this._write(next, { source, action: 'set' });
      await this.refreshSnapshot();
      return next;
    });
  }

  async history({ limit = 10 } = {}) {
    try {
      return (await fs.readFile(`${this.file}.history.jsonl`, 'utf8')).trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().slice(0, limit);
    } catch { return []; }
  }

  /**
   * Undo a change: restore the profile to the state it had BEFORE history
   * entry `index` (0 = the most recent change, same order as history()).
   * The restore is itself recorded in the history log, so it can be undone.
   * @param {number} index - 0 = most recent entry, 1 = one before that, etc.
   * @returns {Promise<string>} The restored profile text.
   */
  async restore(index = 0) {
    return this._serial(async () => {
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`Invalid history index: ${index}`);
      }
      let raw;
      try {
        raw = await fs.readFile(`${this.file}.history.jsonl`, 'utf8');
      } catch (err) {
        throw new Error(`Profile history unavailable: ${err.code || err.message}`);
      }
      const entries = raw.trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .reverse(); // most recent first
      if (index >= entries.length) {
        throw new Error(`Invalid history index: ${index}. ${entries.length ? `Available entries: 0-${entries.length - 1}` : 'History is empty'}`);
      }
      const entry = entries[index];
      if (typeof entry.before !== 'string') {
        throw new Error('Selected history entry has no "before" state');
      }
      await this._write(entry.before, { source: 'operator', action: 'restore' });
      await this.refreshSnapshot();
      logger.info(`[profile] Restored the state before history entry ${index} (${entry.at})`);
      return entry.before.trim();
    });
  }

  /**
   * Compact the profile with the side-model once it grows past its budget: merge duplicates,
   * drop what later lines contradict, keep it under ~1400 characters. Then refresh the snapshot.
   */
  async tidy(providerManager, { force = false } = {}) {
    const current = await this.text();
    if (!current || (!force && current.length <= MAX_CHARS)) { await this.refreshSnapshot(); return { changed: false, chars: current.length }; }
    const gen = providerManager?.generateAux || providerManager?.generateResponse;
    if (!gen) return { changed: false, chars: current.length };
    const res = await gen.call(providerManager, `Rewrite this profile of an AI agent's operator as a compact bullet list under ${TIDY_TARGET} characters. Merge duplicates. When lines conflict, keep the later one (lower in the list). Keep every durable preference, rule and fact; drop anything transient. Never invent anything. Output only the bullet list.\n\n${current}`, { maxTokens: 900, temperature: 0, auxTask: 'profile-tidy' });
    const next = String(res?.content || '').trim();
    if (!next || next.length > current.length || !next.startsWith('-')) { await this.refreshSnapshot(); return { changed: false, chars: current.length }; }
    await this._serial(() => this._write(next, { source: 'tidy', action: 'tidy' }));
    await this.refreshSnapshot();
    logger.info(`[profile] tidied ${current.length} → ${next.length} characters`);
    return { changed: true, from: current.length, chars: next.length };
  }

  /** One-time seed from facts memory already holds about the operator (category master_*). */
  async seedFromMemory(memoryModel, providerManager) {
    if ((await this.text()) || !memoryModel) return 0;
    const rows = await memoryModel.find({ 'metadata.category': /^master_/ }).sort({ createdAt: 1 }).limit(60).lean().catch(() => []);
    const facts = rows.map(r => String(r.content || '').slice(0, 300)).filter(Boolean);
    if (!facts.length) return 0;
    const gen = providerManager?.generateAux || providerManager?.generateResponse;
    let lines = facts;
    if (gen) {
      const res = await gen.call(providerManager, `These are facts an AI agent stored about its operator. Turn them into a short bullet list of durable facts and preferences (max 15 bullets, one short line each). Drop anything transient or duplicated. Never invent. Output only the bullets.\n\n${facts.map(f => `- ${f}`).join('\n')}`, { maxTokens: 700, temperature: 0, auxTask: 'profile-seed' }).catch(() => null);
      const out = String(res?.content || '').split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
      if (out.length) lines = out;
    }
    const added = await this.add(lines, 'seed-from-memory');
    await this.refreshSnapshot();
    return added.length;
  }
}

let instance = null;
export function getUserProfile() {
  if (!instance) instance = new UserProfile();
  return instance;
}
