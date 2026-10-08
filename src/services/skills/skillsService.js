import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import { DATA_PATH } from '../../utils/paths.js';
import { embeddingService } from '../embeddingService.js';
import { SKILL_WRITING_RULES } from './skillQuality.js';

/**
 * Skills: procedures written as markdown, in the agentskills.io SKILL.md format.
 *
 *   data/skills/<name>/SKILL.md
 *   ---
 *   name: rotate-vpn-exit
 *   description: How to move the scrape VPN to a new US exit without dropping the tunnel
 *   ---
 *   1. ...
 *
 * Only the name and description are indexed; a skill's body is loaded when a request
 * matches it, so any number of skills costs nothing until one is relevant. Skills can be
 * written by hand, dropped in from elsewhere (the format is an open standard), created
 * through the `skills` plugin, or drafted by the agent itself after a multi-step task
 * succeeds (SKILLS_AUTO_LEARN, on by default).
 *
 * A skill another AGENT teaches in a Trellis channel (learnSkillFromPeer) is saved with
 * `status: pending` and is not used until the operator approves it (or skills.autoApprovePeer
 * is on): a procedure from a peer is instructions from outside, and a matched skill is put
 * into the prompt of the operator's own requests.
 *
 * Over the Skynet P2P network agents teach each other directly (p2p/skillSharing.js, on by
 * default, `skills.p2pShare`). installPeerSkill() is the one way such a skill is saved: active
 * when the sender is trusted (peerSkillsTrusted), pending otherwise.
 */

/** Emits 'activated' {name, source} whenever a skill becomes usable (p2p sharing listens). */
export const skillEvents = new EventEmitter();

export const SKILLS_DIR = process.env.SKILLS_PATH || path.join(DATA_PATH, 'skills');
// Skills that ship with the code (repo `skills/`), read-only and always active. A skill of the
// same name in SKILLS_DIR overrides the bundled one, so an operator can tailor any of them.
export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../../../skills/', import.meta.url));
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_PENDING_PEER = 25;
const MAX_BODY = 20000;
const RESCAN_MS = 60 * 1000;

/** Parse SKILL.md frontmatter: `key: value`, quoted values, and `>` / `|` block values. */
/** True when a skill has no `match_requires`, or the request contains one of its terms. */
export function requiredTermPresent(requires, query) {
  const terms = String(requires || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  if (!terms.length) return true;
  const q = String(query || '').toLowerCase();
  return terms.some(t => (/^[\w-]+$/.test(t) ? new RegExp(`(^|[^\\w-])${t.replace(/[-]/g, '\\-')}($|[^\\w-])`).test(q) : q.includes(t)));
}

export function parseSkill(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const meta = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = value.startsWith('>') ? block.filter(Boolean).join(' ') : block.join('\n').trim();
    } else if (/^".*"$/.test(value)) {
      // renderSkill writes quoted values with JSON.stringify: decode its escapes (\" \\), or a
      // description containing a quote would not survive a SKILL.md round trip.
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (/^'.*'$/.test(value)) {
      value = value.slice(1, -1);
    }
    meta[m[1]] = value;
  }
  return { meta, body: match[2].trim() };
}

export function renderSkill({ name, description, body, extra = {} }) {
  const esc = (v) => (/[:#'"\n]/.test(String(v)) ? JSON.stringify(String(v).replace(/\n/g, ' ')) : String(v));
  const fm = [`name: ${name}`, `description: ${esc(description)}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${esc(v)}`)];
  return `---\n${fm.join('\n')}\n---\n\n${String(body).trim()}\n`;
}

/**
 * Does `score` stand out from the other skills' scores? It must beat their mean by `minLift`.
 * Measured on ALICE (ada-002, 15 skills, 2026-09-28): real requests put the right skill
 * 0.073-0.163 above the mean; greetings and off-topic requests top out at 0.031. A lift over
 * the mean (not a z-score) lets two genuinely relevant skills both through: two high scores
 * inflate the spread and would push each other under a z threshold.
 * With fewer than 4 skills there is no distribution to judge, so it passes.
 */
export function standsOut(score, all, minLift) {
  if (!minLift || all.length < 4) return true;
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  return score - mean >= minLift;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'how', 'do', 'i', 'my', 'me', 'is', 'it', 'with', 'what', 'can', 'you', 'please']);
const words = (t) => String(t).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));

export class SkillsService {
  constructor({ dir, bundledDir, embed = (t) => embeddingService.generateEmbedding(t) } = {}) {
    this.dir = dir || SKILLS_DIR;
    // An instance pointed at its own dir (tests, tools) sees only that dir unless told otherwise.
    this.bundledDir = bundledDir !== undefined ? bundledDir : (dir ? null : BUNDLED_SKILLS_DIR);
    this.embed = embed;
    this.skills = new Map();
    this.scannedAt = 0;
    this.embeddings = new Map(); // name -> { description, vector }
  }

  async scan(force = false) {
    if (!force && Date.now() - this.scannedAt < RESCAN_MS) return this.skills;
    const found = new Map();
    // bundled first, so a same-named skill in the instance's own dir replaces it
    for (const [root, bundled] of [[this.bundledDir, true], [this.dir, false]]) {
      if (root) await this._scanDir(root, bundled, found);
    }
    this.skills = found;
    this.scannedAt = Date.now();
    return found;
  }

  async _scanDir(root, bundled, found) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn(`Skills directory unreadable: ${error.message}`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;   // .archive, .history
      const file = path.join(root, entry.name, 'SKILL.md');
      try {
        const parsed = parseSkill(await fs.readFile(file, 'utf8'));
        if (!parsed?.meta.name || !parsed.meta.description) {
          logger.warn(`Skipping ${file}: frontmatter needs name and description`);
          continue;
        }
        found.set(parsed.meta.name, {
          name: parsed.meta.name,
          description: parsed.meta.description,
          body: parsed.body.substring(0, MAX_BODY),
          meta: parsed.meta,
          path: file,
          bundled
        });
      } catch (error) {
        if (error.code !== 'ENOENT') logger.warn(`Skipping ${file}: ${error.message}`);
      }
    }
  }

  async list() {
    await this.scan();
    return [...this.skills.values()].map(({ name, description, meta, bundled }) => ({
      name, description, source: meta.source || (bundled ? 'bundled' : 'manual'), status: bundled ? 'active' : (meta.status || 'active'),
      ...(bundled ? { bundled: true } : {}),
      ...(meta.taught_by ? { taughtBy: meta.taught_by } : {})
    }));
  }

  /** Skills waiting for the operator's approval. */
  async pending() {
    return (await this.list()).filter(s => s.status === 'pending');
  }

  /** Approve every pending skill at once. Returns the names approved. */
  async approveAll() {
    const names = (await this.pending()).map(s => s.name);
    for (const n of names) await this.approve(n);
    return names;
  }

  /** Throw away a PENDING skill (a rejected peer-taught one). Active skills use remove(). */
  async reject(name) {
    const skill = await this.get(name);
    if (!skill || (skill.meta?.status || 'active') !== 'pending') return false;
    return this.remove(name);
  }

  /** Make a pending skill usable (operator approval of a peer-taught skill). */
  async approve(name) {
    const skill = await this.get(name);
    if (!skill) return null;
    const { name: _n, description: _d, status: _s, ...extra } = skill.meta;
    await fs.writeFile(skill.path, renderSkill({ name: skill.name, description: skill.description, body: skill.body, extra: { ...extra, status: 'active' } }), 'utf8');
    await this.scan(true);
    logger.info(`Skill approved: ${skill.name}`);
    skillEvents.emit('activated', { name: skill.name, source: skill.meta?.source || 'manual' });
    return this.skills.get(skill.name);
  }

  async get(name) {
    await this.scan();
    return this.skills.get(name) || null;
  }

  async vectorFor(skill) {
    const cached = this.embeddings.get(skill.name);
    if (cached && cached.description === skill.description) return cached.vector;
    const vector = await this.embed(`${skill.name.replace(/-/g, ' ')}: ${skill.description}`);
    this.embeddings.set(skill.name, { description: skill.description, vector });
    return vector;
  }

  /**
   * Skills relevant to a request, best first. Embedding similarity when available,
   * otherwise keyword overlap with the name and description.
   */
  async match(query, { limit = 2, minSimilarity = Number(process.env.SKILLS_MIN_SIMILARITY) || 0.5, minLift = Number(process.env.SKILLS_MIN_LIFT) || 0.05, withScores = false, skills: pool = null } = {}) {
    await this.scan();
    // Pending skills (taught by another agent, not yet approved) are never used.
    // A skill scoped to one thing names it in `match_requires` (comma-separated terms) and is
    // eligible only when the request contains one. Embeddings cannot honour "only for card 209":
    // "did you determine a plan?" matched run-standard-agent-test at 0.79 (card 21 #3266).
    const skills = (pool || [...this.skills.values()])
      .filter(s => (s.meta?.status || 'active') !== 'pending')
      .filter(s => requiredTermPresent(s.meta?.match_requires, query));
    if (!skills.length || !query) return [];
    try {
      const q = await this.embed(query);
      const scored = [];
      for (const s of skills) scored.push({ skill: s, score: cosine(q, await this.vectorFor(s)) });
      // ada-002 packs every pair into ~0.70-0.76, so an absolute cutoff let two unrelated skills
      // into the prompt of every "Hello?". A real match stands out from the other skills.
      const all = scored.map(y => y.score);
      const mean = all.reduce((a, b) => a + b, 0) / (all.length || 1);
      const hits = scored.filter(x => x.score >= minSimilarity && standsOut(x.score, all, minLift))
        .sort((a, b) => b.score - a.score).slice(0, limit);
      if (hits.length) logger.info(`Skill match: ${hits.map(h => `${h.skill.name} (${h.score.toFixed(2)})`).join(', ')}`);
      // withScores: the caller also gets how far each hit stands above the others (`lift`),
      // e.g. to offer a skill to another agent only on a strong match.
      return withScores ? hits.map(x => ({ skill: x.skill, score: x.score, lift: x.score - mean })) : hits.map(x => x.skill);
    } catch (error) {
      logger.debug(`Skill embedding match unavailable (${error.message}); using keywords`);
      const qw = new Set(words(query));
      return skills
        .map(s => ({ skill: s, score: words(`${s.name} ${s.description}`).filter(w => qw.has(w)).length }))
        .filter(x => x.score >= 2)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => (withScores ? { skill: x.skill, score: null, lift: null } : x.skill));
    }
  }

  /** Prompt section for matched skills, or '' when none match. */
  async promptFor(query, opts = {}) {
    const matched = await this.match(query, opts);
    if (!matched.length) return '';
    this.recordUse(matched.map(m => m.name)).catch(() => {});
    return matched.map(s => `### Skill: ${s.name}\n${s.description}\n\n${s.body.substring(0, 4000)}`).join('\n\n');
  }

  async create({ name, description, body, overwrite = false, extra = {} }) {
    const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 64);
    if (!NAME_RE.test(slug)) throw new Error('Skill name must be lowercase letters, digits and hyphens');
    if (!description || String(description).length > 1024) throw new Error('A description (up to 1024 characters) is required');
    if (!body || !String(body).trim()) throw new Error('A skill needs a body (the procedure itself)');
    const dir = path.join(this.dir, slug);
    const file = path.join(dir, 'SKILL.md');
    if (!overwrite) {
      const exists = await fs.access(file).then(() => true, () => false);
      // a learned skill must not silently shadow a bundled one of the same name
      // Say what to do instead: on 2026-10-03 ReAct answered a bare "already exists" by DELETING
      // the skill to recreate it, which throws away its history and rollback.
      if (exists || (await this.scan(), this.skills.get(slug)?.bundled)) {
        throw new Error(this.skills.get(slug)?.bundled
          ? `Skill "${slug}" already exists (built in). Choose another name; built-in skills cannot be replaced.`
          : `Skill "${slug}" already exists. To change it use skills.update({ name: "${slug}", body, description }) — that keeps its history and rollback. Do not delete it to recreate it.`);
      }
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, renderSkill({ name: slug, description, body: String(body).substring(0, MAX_BODY), extra }), 'utf8');
    await this.scan(true);
    logger.info(`Skill saved: ${slug}${extra.source ? ` (${extra.source})` : ''}`);
    const saved = this.skills.get(slug);
    if (saved && (saved.meta?.status || 'active') === 'active') skillEvents.emit('activated', { name: slug, source: extra.source || 'manual' });
    return saved;
  }

  // ─── Lifecycle: usage, updates with history, archive, pin (after Hermes' curator) ───────
  //
  // Usage lives in a sidecar, never in SKILL.md: .usage.json {name: {uses, lastUsed, created,
  // pinned, state}}. Every change to a skill's text appends {at, actor, reason, before, after}
  // to .history/<name>.jsonl so any edit can be rolled back. Archiving moves the folder to
  // .archive/ (recoverable); nothing here deletes a skill.

  async _readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(path.join(this.dir, file), 'utf8')); } catch { return fallback; }
  }

  async _writeJson(file, data) {
    await fs.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, file);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, target);
  }

  /** Usage records by name. Serialised through one promise so concurrent bumps don't lose counts. */
  async usage() { return this._readJson('.usage.json', {}); }

  async _updateUsage(mutate) {
    this._usageChain = (this._usageChain || Promise.resolve()).then(async () => {
      const u = await this.usage();
      mutate(u);
      await this._writeJson('.usage.json', u);
    }).catch(err => logger.debug(`Skill usage not saved: ${err.message}`));
    return this._usageChain;
  }

  /** A skill was put in front of the model for a request. */
  async recordUse(names) {
    const now = new Date().toISOString();
    return this._updateUsage(u => {
      for (const n of names) {
        const r = u[n] || { uses: 0, created: now };
        r.uses = (r.uses || 0) + 1;
        r.lastUsed = now;
        if (r.state === 'stale') r.state = 'active';
        u[n] = r;
      }
    });
  }

  async setPinned(name, pinned) {
    if (!(await this.get(name))) throw new Error(`No skill named "${name}"`);
    await this._updateUsage(u => { u[name] = { ...(u[name] || { uses: 0, created: new Date().toISOString() }), pinned: !!pinned }; });
    return { name, pinned: !!pinned };
  }

  async _appendHistory(name, entry) {
    const dir = path.join(this.dir, '.history');
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, `${name}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  }

  /** The change history of a skill, newest first. */
  async history(name, { limit = 20 } = {}) {
    try {
      const lines = (await fs.readFile(path.join(this.dir, '.history', `${name}.jsonl`), 'utf8')).trim().split('\n').filter(Boolean);
      return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().slice(0, limit);
    } catch { return []; }
  }

  /**
   * Change a skill's description and/or body in place (a bundled skill gets an override in the
   * instance's own directory; the shipped file is never touched). Returns the updated skill.
   * @param {{actor?: string, reason?: string}} who - recorded in the history
   */
  async update(name, { description, body } = {}, { actor = 'operator', reason = '' } = {}) {
    const skill = await this.get(name);
    if (!skill) throw new Error(`No skill named "${name}"`);
    const nextDescription = description !== undefined ? String(description).replace(/\s*\n\s*/g, ' ').trim() : skill.description;
    const nextBody = body !== undefined ? String(body).trim().substring(0, MAX_BODY) : skill.body;
    if (!nextDescription || nextDescription.length > 1024) throw new Error('A description (up to 1024 characters) is required');
    if (!nextBody) throw new Error('A skill needs a body');
    if (nextDescription === skill.description && nextBody === skill.body) return skill;
    const { name: _n, description: _d, ...extra } = skill.meta || {};
    const target = skill.bundled ? path.join(this.dir, skill.name, 'SKILL.md') : skill.path;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, renderSkill({ name: skill.name, description: nextDescription, body: nextBody, extra: { ...extra, ...(skill.bundled ? { overrides: 'bundled' } : {}) } }), 'utf8');
    await this._appendHistory(skill.name, {
      actor, reason: String(reason).substring(0, 500), action: 'update',
      before: { description: skill.description, body: skill.body }, after: { description: nextDescription, body: nextBody }
    });
    this.embeddings.delete(skill.name);
    await this.scan(true);
    logger.info(`Skill updated: ${skill.name} by ${actor}${reason ? ` (${reason.substring(0, 120)})` : ''}`);
    return this.skills.get(skill.name);
  }

  /** Undo the most recent change to a skill's text. */
  async rollback(name, { actor = 'operator' } = {}) {
    const [last] = await this.history(name, { limit: 1 });
    if (!last || last.action !== 'update' || !last.before) throw new Error(`"${name}" has no change to roll back`);
    return this.update(name, last.before, { actor, reason: `rollback of the ${last.at} change` });
  }

  /** Move a skill out of use to .archive/ (recoverable with restore). Bundled skills can't be archived. */
  async archive(name, { actor = 'operator', reason = '' } = {}) {
    const skill = await this.get(name);
    if (!skill) throw new Error(`No skill named "${name}"`);
    if (skill.bundled) throw new Error(`"${name}" ships with LANAgent and cannot be archived; pin or override it instead`);
    const dest = path.join(this.dir, '.archive', `${name}--${Date.now()}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(path.dirname(skill.path), dest);
    await this._appendHistory(name, { actor, reason: String(reason).substring(0, 500), action: 'archive', archivedTo: path.basename(dest) });
    await this._updateUsage(u => { u[name] = { ...(u[name] || {}), state: 'archived', archivedAt: new Date().toISOString() }; });
    this.embeddings.delete(name);
    await this.scan(true);
    logger.info(`Skill archived: ${name} by ${actor}${reason ? ` (${reason.substring(0, 120)})` : ''}`);
    return true;
  }

  /**
   * Undo what the background review last did to a skill: roll back its last update, or archive a
   * skill it created. Used by the Telegram "Undo" button on a learning notice.
   */
  async undoLearned(name, { actor = 'operator' } = {}) {
    const skill = await this.get(name);
    if (!skill) throw new Error(`No skill named "${name}"`);
    const [last] = await this.history(name, { limit: 1 });
    if (last?.action === 'update') { await this.rollback(name, { actor }); return { undone: 'update', name }; }
    if (skill.meta?.learned_via === 'background-review') { await this.archive(name, { actor, reason: 'operator removed a learned skill' }); return { undone: 'create', name }; }
    throw new Error(`Nothing learned to undo on "${name}"`);
  }

  /** Archived skills: [{name, folder, archivedAt}]. */
  async archived() {
    try {
      const names = await fs.readdir(path.join(this.dir, '.archive'));
      return names.map(f => ({ name: f.replace(/--\d+$/, ''), folder: f, archivedAt: new Date(Number(f.split('--').pop()) || 0).toISOString() }))
        .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    } catch { return []; }
  }

  async restore(name, { actor = 'operator' } = {}) {
    const hit = (await this.archived()).find(a => a.name === name || a.folder === name);
    if (!hit) throw new Error(`No archived skill "${name}"`);
    if (await this.get(hit.name)) throw new Error(`A skill named "${hit.name}" is active; archive or rename it first`);
    await fs.rename(path.join(this.dir, '.archive', hit.folder), path.join(this.dir, hit.name));
    await this._appendHistory(hit.name, { actor, action: 'restore' });
    await this._updateUsage(u => { u[hit.name] = { ...(u[hit.name] || {}), state: 'active', lastUsed: new Date().toISOString() }; });
    await this.scan(true);
    return this.skills.get(hit.name);
  }

  /** Peer skills the operator rejected or deleted: {name, origin, at}. Never re-installed. */
  async rejectedPeerSkills() {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, '.p2p-rejected.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  async isPeerSkillRejected(name, origin = '') {
    return (await this.rejectedPeerSkills()).some(r => r.name === name && (r.origin || '') === (origin || ''));
  }

  /** @param {{remember?: boolean}} [opts] remember:false — a sync dropping a skill, not the operator rejecting it */
  async remove(name, { remember = true } = {}) {
    const skill = await this.get(name);
    if (!skill) return false;
    if (skill.bundled) throw new Error(`"${name}" ships with LANAgent and cannot be deleted; save a skill of the same name to replace it`);
    if (remember && (skill.meta?.source === 'peer' || skill.meta?.source === 'trellis')) {
      // Remember it, or the next P2P or Skills-basket sync would install it straight back
      const list = (await this.rejectedPeerSkills()).filter(r => !(r.name === name && (r.origin || '') === (skill.meta.origin || '')));
      list.push({ name, origin: skill.meta.origin || '', at: new Date().toISOString() });
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(path.join(this.dir, '.p2p-rejected.json'), JSON.stringify(list.slice(-500), null, 2), 'utf8');
    }
    await fs.rm(path.dirname(skill.path), { recursive: true, force: true });
    this.embeddings.delete(name);
    await this.scan(true);
    return true;
  }
}

let instance = null;
export function getSkillsService() {
  if (!instance) instance = new SkillsService();
  return instance;
}

export default getSkillsService;

/**
 * Draft a skill from a multi-step reasoning task that succeeded, so the next similar request
 * starts from a known procedure. Uses the auxiliary (cheap) model. Skipped when disabled
 * (SKILLS_AUTO_LEARN=false), for short tasks, or when an existing skill already covers it.
 * Never throws: learning is best effort and must not affect the reply.
 */
/**
 * The plugin-chain path (agent.js → pluginChainProcessor.executeChain) records
 * planned steps and per-step results instead of ReAct thoughts. Convert the
 * steps that succeeded into the thought shape learnSkillFromTask reads, so
 * multi-step chains can become skills too. Failed steps are left out: a skill
 * should describe what worked.
 */
export function chainToThoughts(steps = [], results = []) {
  return results
    .map((r, i) => ({ r, step: steps[i] || {} }))
    .filter(({ r }) => r && r.success)
    .map(({ r, step }) => ({
      type: 'action',
      content: { tool: r.plugin || step.plugin, command: r.action || step.action, params: step.params || {} }
    }));
}

export async function learnSkillFromTask({ providerManager, service = getSkillsService(), query, thoughts = [], answer = '', minSteps = 3 }) {
  try {
    if (String(process.env.SKILLS_AUTO_LEARN || 'true').toLowerCase() === 'false') return null;
    const steps = thoughts.filter(t => t.type === 'action').map(t => `${t.content.tool}.${t.content.command}(${JSON.stringify(t.content.params || {})})`);
    if (steps.length < minSteps || !providerManager) return null;
    const existing = await service.match(query, { limit: 1 });
    if (existing.length) {
      logger.info(`Skill learning: "${existing[0].name}" already covers this task`);
      return null;
    }

    const prompt = `A task was completed successfully in these steps. Write a reusable skill (procedure) for tasks like it.

Task: ${query}
Steps taken: ${steps.join('\n')}
Outcome: ${String(answer).substring(0, 800)}

${SKILL_WRITING_RULES}

Return JSON only:
{"name": "short-kebab-case-name", "description": "Use this skill when ... (what the user wants, including phrasings that don't name it)", "body": "Markdown: numbered steps naming the tool.command calls and the parameters that matter, then a ## Gotchas section for anything that went wrong or was non-obvious"}
Generalise the steps (no one-off values unless they are always the same). If the task is too one-off to reuse, return {"skip": true}.`;

    const response = await (providerManager.generateAux || providerManager.generateResponse).call(providerManager, prompt, { maxTokens: 900, temperature: 0.2, auxTask: 'skill-learning' });
    const json = String(response?.content || '').match(/\{[\s\S]*\}/);
    if (!json) return null;
    const draft = JSON.parse(json[0]);
    if (draft.skip || !draft.name || !draft.description || !draft.body) {
      logger.info(`Skill learning: a ${steps.length}-step task was judged too one-off to keep`);
      return null;
    }
    const created = await service.create({ ...draft, extra: { source: 'auto', learned_from: String(query).substring(0, 200) } });
    if (created) logger.info(`Skill learned: ${draft.name} (from a ${steps.length}-step task)`);
    return created;
  } catch (error) {
    logger.debug(`Skill learning skipped: ${error.message}`);
    return null;
  }
}

const AUTO_APPROVE_KEY = 'skills.autoApprovePeer';
export const DEFAULT_AUTO_APPROVE = true;

/**
 * Whether skills other agents teach in Trellis channels are used at once. ON by default
 * (operator, 2026-09-28: "make auto approve the default for all lanagent"); the operator is
 * still told on Telegram with a Reject button. SKILLS_AUTO_APPROVE in .env wins, then the
 * saved setting, then the default. Skills from UNTRUSTED Skynet P2P peers do not use this:
 * they always wait for approval (peerSkillsTrusted decides there).
 */
export async function getAutoApprove() {
  const env = String(process.env.SKILLS_AUTO_APPROVE || '').toLowerCase();
  if (env === 'true' || env === 'false') return { enabled: env === 'true', source: 'env' };
  try {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    const v = await SystemSettings.getSetting(AUTO_APPROVE_KEY, null);
    if (v === null || v === undefined) return { enabled: DEFAULT_AUTO_APPROVE, source: 'default' };
    return { enabled: v === true || v === 'true', source: 'setting' };
  } catch {
    return { enabled: DEFAULT_AUTO_APPROVE, source: 'default' };
  }
}

export async function setAutoApprove(enabled) {
  const { SystemSettings } = await import('../../models/SystemSettings.js');
  await SystemSettings.setSetting(AUTO_APPROVE_KEY, !!enabled, 'Use skills other agents teach without asking the operator first', 'skills');
  logger.info(`Skill auto-approval ${enabled ? 'ON' : 'OFF'}`);
  return getAutoApprove();
}

/** Whether a skill body is something an agent runs: it names a tool command or an API call. */
export function isActionableSkill(body, toolCommands = null) {
  const text = String(body || '');
  if (/\b(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/\S+|\/\S+)/.test(text)) return true;
  if (/\b[a-z][\w-]*\.[a-z]\w*\s*\(/.test(text)) return true;               // plugin.command(…)
  for (const c of toolCommands || []) {
    if (c && c.length >= 5 && new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) return true;
  }
  return false;
}

/**
 * Save a procedure another agent taught in a channel as a PENDING skill (unused until the
 * operator approves it). Returns the saved skill, or null when the message teaches nothing
 * reusable. Uses the auxiliary model. Never throws.
 */
export async function learnSkillFromPeer({ providerManager, service = getSkillsService(), text, from, context = '', toolCommands = null }) {
  try {
    if (String(process.env.SKILLS_AUTO_LEARN || 'true').toLowerCase() === 'false') return null;
    if (!providerManager || !text || String(text).length < 120) return null;
    const prompt = `Another AI agent (${from}) sent this message to you in a shared channel. Decide whether it teaches a REUSABLE procedure: concrete steps for a kind of task, that you could follow next time.

Recent conversation, for context:
${String(context).substring(0, 2500)}

Message from ${from}:
${String(text).substring(0, 5000)}

${SKILL_WRITING_RULES}

Return JSON only:
{"name": "short-kebab-case-name", "description": "Use this skill when ... (what the user wants)", "body": "Markdown: when to use it, numbered steps, pitfalls mentioned"}
Write it in your own words for an agent with its OWN tools; keep API routes and field names exactly as given. If the message is chat, thanks, a status report, advice for a PERSON (click this, pick from that menu, type @) or anything else that is not a procedure an agent runs with tools, return {"skip": true}.`;
    const response = await (providerManager.generateAux || providerManager.generateResponse).call(providerManager, prompt, { maxTokens: 900, temperature: 0.2, auxTask: 'skill-learning' });
    const json = String(response?.content || '').match(/\{[\s\S]*\}/);
    if (!json) return null;
    const draft = JSON.parse(json[0]);
    if (draft.skip || !draft.name || !draft.description || !draft.body) return null;
    // Only something this agent can run: it names one of its tool commands, or an API call
    // (a method and a route). Chat saved as skills on 2026-10-02 included "type @ and pick the
    // agent from the mention picker" (advice for the operator) and a four-line "use a POST tool".
    if (!isActionableSkill(draft.body, toolCommands)) {
      logger.info(`Peer skill learning: "${draft.name}" from ${from} names no tool or API call this agent can run; not saved`);
      return null;
    }
    const auto = (await getAutoApprove()).enabled;
    return await service.create({ ...draft, overwrite: false, extra: { source: 'peer', taught_by: String(from).substring(0, 80), status: auto ? 'active' : 'pending', ...(auto ? { auto_approved: 'true' } : {}) } });
  } catch (error) {
    logger.debug(`Peer skill learning skipped: ${error.message}`);
    return null;
  }
}

/**
 * Hash of a skill's shared content. Description whitespace is flattened and the body trimmed
 * the same way a SKILL.md round trip does, so a stored copy hashes like the one sent.
 */
export function skillHash({ name, description, body }) {
  const d = String(description || '').replace(/\s*\n\s*/g, ' ').trim();
  const b = String(body || '').trim();
  return crypto.createHash('sha256').update(JSON.stringify([String(name), d, b])).digest('hex');
}

const P2P_SHARE_KEY = 'skills.p2pShare';
const P2P_MIN_SCORE_KEY = 'skills.p2pMinTrustScore';
export const DEFAULT_P2P_MIN_TRUST_SCORE = 50;

/**
 * Skill sharing between agents over the Skynet P2P network. ON by default, for new installs
 * too: SKILLS_P2P_SHARE in .env wins, then the saved setting, then true.
 */
export async function getSkillSharing() {
  let enabled = true;
  let source = 'default';
  let minTrustScore = DEFAULT_P2P_MIN_TRUST_SCORE;
  try {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    const saved = await SystemSettings.getSetting(P2P_SHARE_KEY, null);
    if (saved === true || saved === false) { enabled = saved; source = 'setting'; }
    const min = Number(await SystemSettings.getSetting(P2P_MIN_SCORE_KEY, DEFAULT_P2P_MIN_TRUST_SCORE));
    if (Number.isFinite(min)) minTrustScore = Math.max(0, Math.min(100, min));
  } catch { /* defaults */ }
  const env = String(process.env.SKILLS_P2P_SHARE || '').toLowerCase();
  if (env === 'true' || env === 'false') { enabled = env === 'true'; source = 'env'; }
  return { enabled, minTrustScore, source };
}

export async function setSkillSharing({ enabled, minTrustScore } = {}) {
  const { SystemSettings } = await import('../../models/SystemSettings.js');
  if (enabled !== undefined) {
    await SystemSettings.setSetting(P2P_SHARE_KEY, !!enabled, 'Teach and learn skills with trusted agents on the Skynet P2P network', 'skills');
    logger.info(`P2P skill sharing ${enabled ? 'ON' : 'OFF'}`);
  }
  if (minTrustScore !== undefined) {
    const n = Number(minTrustScore);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('minTrustScore must be 0-100');
    await SystemSettings.setSetting(P2P_MIN_SCORE_KEY, n, 'Trust score at which a peer\'s skills are used without approval', 'skills');
  }
  return getSkillSharing();
}

/** A peer whose skills are used at once: genesis, operator-trusted, or score >= the minimum. */
export function peerSkillsTrusted(peer, minTrustScore = DEFAULT_P2P_MIN_TRUST_SCORE) {
  if (!peer) return false;
  const trusted = typeof peer.isTrusted === 'function' ? peer.isTrusted() : (peer.trustLevel === 'trusted' || peer.isGenesis === true);
  return trusted || (Number(peer.trustScore) || 0) >= minTrustScore;
}

/**
 * Save a skill another agent sent (P2P push or a knowledge pack). Never overwrites a skill
 * written locally, a bundled one, or one of the same name from a different author.
 * @param {object} opts
 * @param {object} opts.skill   {name, description, body, sha256, origin, originName}
 * @param {boolean} opts.trusted  sender passes peerSkillsTrusted → active; otherwise pending
 * @param {{fingerprint: string, name: string}} opts.from
 * @param {string} [opts.via]   'p2p' | 'knowledge_pack:<id>'
 * @returns {Promise<{saved: boolean, status?: string, skill?: object, reason?: string}>}
 */
export async function installPeerSkill({ service = getSkillsService(), skill, trusted, from = {}, via = 'p2p' }) {
  try {
    if (!skill || typeof skill !== 'object') return { saved: false, reason: 'no skill' };
    const { name, description, body, sha256 } = skill;
    if (typeof name !== 'string' || name.length > 64 || !NAME_RE.test(name)) return { saved: false, reason: 'invalid name' };
    if (typeof description !== 'string' || !description.trim() || description.length > 1024) return { saved: false, reason: 'invalid description' };
    if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY) return { saved: false, reason: 'invalid body' };
    if (sha256 !== skillHash({ name, description, body })) return { saved: false, reason: 'content does not match its hash' };
    const origin = typeof skill.origin === 'string' && /^[0-9a-f]{8,64}$/.test(skill.origin) ? skill.origin : (from.fingerprint || '');

    if (await service.isPeerSkillRejected?.(name, origin)) return { saved: false, reason: `"${name}" was rejected by the operator` };

    const existing = await service.get(name);
    if (existing) {
      if (existing.bundled) return { saved: false, reason: `"${name}" is a bundled skill` };
      if (existing.meta?.source !== 'peer') return { saved: false, reason: `a local skill is named "${name}"` };
      if ((existing.meta?.origin || '') !== origin) return { saved: false, reason: `"${name}" from another author is already installed` };
      if (existing.meta?.sha256 === sha256) return { saved: false };
      if (!trusted) return { saved: false, reason: 'updates are only taken from trusted peers' };
    } else if (!trusted) {
      const pending = (await service.pending()).length;
      if (pending >= MAX_PENDING_PEER) return { saved: false, reason: `${pending} skills already await approval` };
    }

    const status = trusted ? 'active' : 'pending';
    const saved = await service.create({
      name,
      description: description.replace(/\s*\n\s*/g, ' ').trim(),
      body: body.trim(),
      overwrite: !!existing,
      extra: {
        source: 'peer',
        taught_by: String(from.name || from.fingerprint || 'peer').substring(0, 80),
        ...(from.fingerprint ? { peer_fingerprint: from.fingerprint } : {}),
        origin,
        ...(skill.originName ? { origin_name: String(skill.originName).substring(0, 80) } : {}),
        sha256,
        received_via: via,
        status
      }
    });
    return { saved: !!saved, status, skill: saved, updated: !!existing };
  } catch (error) {
    logger.warn(`Peer skill not saved: ${error.message}`);
    return { saved: false, reason: error.message };
  }
}
