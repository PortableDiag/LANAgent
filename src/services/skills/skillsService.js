import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { DATA_PATH } from '../../utils/paths.js';
import { embeddingService } from '../embeddingService.js';

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
 */

export const SKILLS_DIR = process.env.SKILLS_PATH || path.join(DATA_PATH, 'skills');
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_BODY = 20000;
const RESCAN_MS = 60 * 1000;

/** Parse SKILL.md frontmatter: `key: value`, quoted values, and `>` / `|` block values. */
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
    } else if (/^(['"]).*\1$/.test(value)) {
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

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'how', 'do', 'i', 'my', 'me', 'is', 'it', 'with', 'what', 'can', 'you', 'please']);
const words = (t) => String(t).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));

export class SkillsService {
  constructor({ dir = SKILLS_DIR, embed = (t) => embeddingService.generateEmbedding(t) } = {}) {
    this.dir = dir;
    this.embed = embed;
    this.skills = new Map();
    this.scannedAt = 0;
    this.embeddings = new Map(); // name -> { description, vector }
  }

  async scan(force = false) {
    if (!force && Date.now() - this.scannedAt < RESCAN_MS) return this.skills;
    const found = new Map();
    let entries = [];
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn(`Skills directory unreadable: ${error.message}`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.dir, entry.name, 'SKILL.md');
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
          path: file
        });
      } catch (error) {
        if (error.code !== 'ENOENT') logger.warn(`Skipping ${file}: ${error.message}`);
      }
    }
    this.skills = found;
    this.scannedAt = Date.now();
    return found;
  }

  async list() {
    await this.scan();
    return [...this.skills.values()].map(({ name, description, meta }) => ({ name, description, source: meta.source || 'manual' }));
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
  async match(query, { limit = 2, minSimilarity = Number(process.env.SKILLS_MIN_SIMILARITY) || 0.5 } = {}) {
    await this.scan();
    const skills = [...this.skills.values()];
    if (!skills.length || !query) return [];
    try {
      const q = await this.embed(query);
      const scored = [];
      for (const s of skills) scored.push({ skill: s, score: cosine(q, await this.vectorFor(s)) });
      const hits = scored.filter(x => x.score >= minSimilarity).sort((a, b) => b.score - a.score).slice(0, limit);
      if (hits.length) logger.info(`Skill match: ${hits.map(h => `${h.skill.name} (${h.score.toFixed(2)})`).join(', ')}`);
      return hits.map(x => x.skill);
    } catch (error) {
      logger.debug(`Skill embedding match unavailable (${error.message}); using keywords`);
      const qw = new Set(words(query));
      return skills
        .map(s => ({ skill: s, score: words(`${s.name} ${s.description}`).filter(w => qw.has(w)).length }))
        .filter(x => x.score >= 2)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => x.skill);
    }
  }

  /** Prompt section for matched skills, or '' when none match. */
  async promptFor(query, opts = {}) {
    const matched = await this.match(query, opts);
    if (!matched.length) return '';
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
      if (exists) throw new Error(`Skill "${slug}" already exists`);
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, renderSkill({ name: slug, description, body: String(body).substring(0, MAX_BODY), extra }), 'utf8');
    await this.scan(true);
    logger.info(`Skill saved: ${slug}${extra.source ? ` (${extra.source})` : ''}`);
    return this.skills.get(slug);
  }

  async remove(name) {
    const skill = await this.get(name);
    if (!skill) return false;
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
export async function learnSkillFromTask({ providerManager, service = getSkillsService(), query, thoughts = [], answer = '', minSteps = 3 }) {
  try {
    if (String(process.env.SKILLS_AUTO_LEARN || 'true').toLowerCase() === 'false') return null;
    const steps = thoughts.filter(t => t.type === 'action').map(t => `${t.content.tool}.${t.content.command}(${JSON.stringify(t.content.params || {})})`);
    if (steps.length < minSteps || !providerManager) return null;
    if ((await service.match(query, { limit: 1 })).length) return null;

    const prompt = `A task was completed successfully in these steps. Write a reusable skill (procedure) for tasks like it.

Task: ${query}
Steps taken: ${steps.join('\n')}
Outcome: ${String(answer).substring(0, 800)}

Return JSON only:
{"name": "short-kebab-case-name", "description": "One sentence: what the skill does and when to use it", "body": "Markdown: when to use it, then numbered steps naming the tool.command calls and the parameters that matter, then pitfalls seen"}
Generalise the steps (no one-off values unless they are always the same). If the task is too one-off to reuse, return {"skip": true}.`;

    const response = await (providerManager.generateAux || providerManager.generateResponse).call(providerManager, prompt, { maxTokens: 900, temperature: 0.2, auxTask: 'skill-learning' });
    const json = String(response?.content || '').match(/\{[\s\S]*\}/);
    if (!json) return null;
    const draft = JSON.parse(json[0]);
    if (draft.skip || !draft.name || !draft.description || !draft.body) return null;
    return await service.create({ ...draft, extra: { source: 'auto', learned_from: String(query).substring(0, 200) } });
  } catch (error) {
    logger.debug(`Skill learning skipped: ${error.message}`);
    return null;
  }
}
