import { logger } from '../../utils/logger.js';
import { getGlobalAgent } from '../../core/agentAccessor.js';
import { getSkillsService } from './skillsService.js';
import { getUserProfile } from './userProfile.js';

/**
 * Privacy audit a skill must pass before it can leave this instance (P2P skill sharing,
 * knowledge packs). Learned skills are written from the operator's own conversations, and
 * the P2P sanitizer only redacts generic shapes (emails, IPs, paths, quoted keys). On
 * 2026-09-30 a skill from the operator's Trellis basket went out carrying the operator's
 * private document id, which none of those shapes match.
 *
 * Two passes over the exact text that would be sent (the sanitized payload):
 *   1. scan  — identifiers no skill needs to share (document/card UUIDs, wallet addresses,
 *              phone numbers, unquoted key prefixes) and this instance's own private terms
 *              (owner email, contact names/emails/phones, Trellis document ids, secret .env
 *              values).
 *   2. model — the side model reads the skill beside the operator's profile and decides
 *              whether it reveals anything about the operator, their clients or their setup.
 * Any finding BLOCKS the skill; nothing is redacted, because rewriting a procedure can break
 * it silently. The operator can release a blocked skill (release()), which holds for that
 * exact content only. Verdicts are keyed by the payload's sha256, so any edit is re-audited.
 * A model failure is not a pass: the skill stays private and is retried later.
 */

const AUDIT_FILE = '.share-audit.json';
// Bumped when the audit itself changes: a skill BLOCKED by an older audit is audited again once
// (v2, 2026-10-02: the auxiliary model blocked public-API skills for naming the public domain).
// A clear verdict or the operator's release is never revisited.
export const AUDIT_VERSION = 2;
const RETRY_ERROR_MS = 60 * 60 * 1000;
const TERMS_TTL_MS = 10 * 60 * 1000;

const GENERIC_CHECKS = [
  { label: 'a document or card id (UUID)', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { label: 'a wallet address', re: /\b0x[a-fA-F0-9]{40}\b/ },
  { label: 'a phone number', re: /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/ },
  { label: 'an API key or token', re: /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-or-[A-Za-z0-9_-]{12,}|tk_[A-Za-z0-9]{12,}|gsk_[A-Za-z0-9]{12,}|dry_pat_[A-Za-z0-9_-]{8,}|agent_[A-Za-z0-9]{16,}|la_[A-Za-z0-9+/=]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpsa]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|glpat-[A-Za-z0-9_-]{16,})\b/ },
  { label: 'a Telegram bot token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ }
];

// .env keys whose values are private to this instance. URLs are left out on purpose: a
// public product's hostname (a Trellis server, an API) is fair to mention in a skill.
const PRIVATE_ENV_KEY = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|SEED|MNEMONIC|PRIVATE|EMAIL|PHONE|USER_ID|CHAT_ID|DOCUMENTS?|ADDRESS)(_|$)/;

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Literal terms that identify this instance or its operator. */
export async function collectPrivateTerms({ env = process.env, contacts = null } = {}) {
  const terms = new Map(); // term -> label
  const add = (value, label) => {
    const v = String(value || '').trim();
    if (v.length < 5 || /^(true|false|null|undefined|\d{1,6})$/i.test(v)) return;
    terms.set(v, label);
  };
  for (const [k, v] of Object.entries(env)) {
    if (!PRIVATE_ENV_KEY.test(k) || !v) continue;
    for (const part of String(v).split(',')) add(part, `this instance's ${k}`);
  }
  let people = contacts;
  if (!people) {
    try {
      const { Memory } = await import('../../models/Memory.js');
      people = await Memory.find(
        { $or: [{ 'metadata.name': { $exists: true } }, { 'metadata.email': { $exists: true } }, { 'metadata.phone': { $exists: true } }] },
        { 'metadata.name': 1, 'metadata.email': 1, 'metadata.phone': 1 }
      ).limit(2000).lean();
      people = people.map(m => m.metadata || {});
    } catch { people = []; }
  }
  for (const p of people) {
    if (p.email) add(p.email, 'a contact\'s email');
    if (p.phone && String(p.phone).replace(/\D/g, '').length >= 7) add(p.phone, 'a contact\'s phone number');
    const name = String(p.name || '').trim();
    if (/\s/.test(name)) add(name, 'a contact\'s name');
    // Parts of a full name, capitalised and long enough not to be an ordinary word.
    for (const part of name.split(/\s+/)) if (/^[A-Z][a-z]{4,}$/.test(part)) add(part, 'a contact\'s name');
  }
  return terms;
}

/** Deterministic findings for a payload. Exported for tests. */
export function scanPayload({ name, description, body, origin = '', originName = '' }, terms = new Map()) {
  // Everything that is sent, metadata included: origin carried a private document id once.
  const text = `${name}\n${description}\n${body}\n${origin}\n${originName}`;
  const findings = [];
  for (const c of GENERIC_CHECKS) if (c.re.test(text)) findings.push(`contains ${c.label}`);
  for (const [term, label] of terms) {
    const re = /^[\w.@+-]+$/.test(term) ? new RegExp(`(^|[^\\w])${escapeRe(term)}($|[^\\w])`) : null;
    if (re ? re.test(text) : text.includes(term)) findings.push(`contains ${label}`);
  }
  return [...new Set(findings)];
}

/**
 * The review's findings, kept only when their quote really occurs in the skill. The model's
 * own yes/no is not used: on 2026-09-30 the side model blocked three general skills while its
 * reasons said they revealed nothing. A finding must point at text that is there.
 * Returns null when the answer cannot be read (which is not a pass). Exported for tests.
 */
export function parseFindings(content, text) {
  const m = String(content || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(j.private_details)) return null;
  const norm = t => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
  const hay = norm(text);
  const out = [];
  for (const d of j.private_details.slice(0, 10)) {
    const quote = norm(d?.quote || '');
    if (quote.length < 3 || !hay.includes(quote)) continue;
    // A finding that is only about a placeholder is not one: the placeholder is what replaced the secret.
    if (/\{\{\s*secret:/i.test(d.quote || '') && /placeholder/i.test(String(d.why || '')) && !/\b(name|email|address|wallet|ip|host)\b/i.test(String(d.why || ''))) continue;
    out.push(`${String(d.why || 'private detail').slice(0, 160)}: "${String(d.quote).slice(0, 80)}"`);
  }
  return out;
}

export class ShareAudit {
  constructor({ service = null, providerManager = null, profile = null, notify = null } = {}) {
    this._service = service;
    this._pm = providerManager;
    this._profile = profile;
    this._notify = notify;
    this._terms = null;
    this._termsAt = 0;
    this._inflight = new Map();
    this._chain = Promise.resolve();
  }

  get service() { return this._service || getSkillsService(); }
  get providerManager() { return this._pm || getGlobalAgent()?.providerManager || null; }

  async _records() { return this.service._readJson(AUDIT_FILE, {}); }

  async _save(sha, record) {
    this._chain = this._chain.then(async () => {
      const all = await this._records();
      all[sha] = record;
      await this.service._writeJson(AUDIT_FILE, all);
    }).catch(err => logger.warn(`Skill share audit: could not save: ${err.message}`));
    return this._chain;
  }

  async _privateTerms() {
    if (!this._terms || Date.now() - this._termsAt > TERMS_TTL_MS) {
      this._terms = await collectPrivateTerms();
      this._termsAt = Date.now();
    }
    return this._terms;
  }

  /** The stored verdict for exactly this payload, or null. */
  async recordFor(payload) {
    return (await this._records())[payload.sha256] || null;
  }

  /** May this exact payload leave the instance? Never runs an audit. */
  async cleared(payload) {
    const r = await this.recordFor(payload);
    return Boolean(r && (r.verdict === 'clear' || r.released));
  }

  /** Audit a payload unless a current verdict exists. Concurrent calls share one run. */
  async audit(payload) {
    const existing = await this.recordFor(payload);
    const staleBlock = existing && existing.verdict === 'blocked' && !existing.released && (existing.auditVersion || 1) < AUDIT_VERSION;
    if (existing && !staleBlock && !(existing.verdict === 'error' && Date.now() - existing.at > RETRY_ERROR_MS)) return existing;
    if (this._inflight.has(payload.sha256)) return this._inflight.get(payload.sha256);
    const run = this._run(payload).finally(() => this._inflight.delete(payload.sha256));
    this._inflight.set(payload.sha256, run);
    return run;
  }

  async _run(payload) {
    const base = { name: payload.name, sha256: payload.sha256, at: Date.now(), auditVersion: AUDIT_VERSION };
    const findings = scanPayload(payload, await this._privateTerms());
    if (findings.length) {
      const record = { ...base, verdict: 'blocked', via: 'scan', findings };
      await this._save(payload.sha256, record);
      await this._report(record);
      return record;
    }

    const pm = this.providerManager;
    if (!pm) {
      const record = { ...base, verdict: 'error', via: 'model', findings: ['no AI provider to review it'] };
      await this._save(payload.sha256, record);
      return record;
    }
    let profile = '';
    try { profile = (await (this._profile || getUserProfile()).text()).slice(0, 3000); } catch { /* none */ }

    const prompt = `You are checking a skill (a reusable procedure an AI agent follows) before it is shared with OTHER PEOPLE's AI agents. Decide whether sharing it would reveal anything private about its owner.

List every detail that would reveal, directly or by clear implication:
- personal details about the owner or anyone else: names, contact details, addresses, schedules, health, family, finances;
- the owner's clients, customers, employer, business deals or private projects;
- identifiers of the owner's accounts, documents, cards, channels, servers, wallets or devices;
- infrastructure: hostnames, IPs, file paths, usernames, internal URLs, ports that are specific to this owner;
- credentials or anything key-shaped;
- trading or investment positions, strategies or amounts.
A general technique that any agent could use reveals nothing: naming a public product, service, API, file format or tool is fine, and so is describing how something works.
These are NOT private and must not be listed: a public website's domain or its documented API routes, HTTP methods, status codes and field names (task_id, react_url…); a credential PLACEHOLDER such as {{secret:host.field}}, <your key>, YOUR_API_KEY or a truncated prefix ending in "…" (agt_…, sk-…); generic words like "agent", "task", "quota". Only list something if it identifies THIS owner, their people, accounts or systems.

What the agent knows about its owner (never to be revealed; use it to recognise private details):
<<<PROFILE
${profile || '(nothing recorded)'}
PROFILE>>>

The skill, exactly as it would be sent:
<<<SKILL
name: ${payload.name}
description: ${payload.description}

${String(payload.body).slice(0, 12000)}
SKILL>>>

Answer JSON only. Quote each detail EXACTLY as it appears in the skill; list nothing you cannot quote.
{"private_details": [{"quote": "exact text from the skill", "why": "what it reveals"}]}
An empty list means the skill is safe to share: {"private_details": []}`;

    let modelFindings = null;
    try {
      // The main model. The auxiliary one kept public-API skills private for naming the public
      // domain, a {{secret:…}} placeholder and a 201 status code (2026-10-02). Credentials, ids,
      // wallets and this owner's terms are caught by the scan above without any model.
      const gen = pm.generateResponse || pm.generateAux;
      const res = await gen.call(pm, prompt, { maxTokens: 600, temperature: 0, auxTask: 'skill-share-audit' });
      modelFindings = parseFindings(res?.content, `${payload.name}\n${payload.description}\n${payload.body}`);
    } catch (err) {
      logger.warn(`Skill share audit of "${payload.name}": model review failed: ${err.message}`);
    }
    if (!modelFindings) {
      const record = { ...base, verdict: 'error', via: 'model', findings: ['the review model gave no usable answer'] };
      await this._save(payload.sha256, record);
      return record;
    }
    const record = modelFindings.length
      ? { ...base, verdict: 'blocked', via: 'model', findings: modelFindings }
      : { ...base, verdict: 'clear', via: 'model', findings: [] };
    await this._save(payload.sha256, record);
    if (record.verdict === 'blocked') await this._report(record);
    else logger.info(`Skill share audit: "${payload.name}" cleared for sharing`);
    return record;
  }

  async _report(record) {
    logger.warn(`Skill share audit: "${record.name}" kept private (${record.via}): ${record.findings.join('; ')}`);
    try {
      const notify = this._notify || (async (text) => {
        const tg = getGlobalAgent()?.interfaces?.get?.('telegram');
        if (tg?.sendNotification) await tg.sendNotification(text);
      });
      await notify(`🔒 Skill "${record.name}" will not be shared with other agents:\n` +
        record.findings.map(f => `• ${f}`).join('\n') +
        `\n\nIt still works here. To share it anyway: "release skill ${record.name} for sharing".`);
    } catch (err) {
      logger.debug(`Skill share audit notice failed: ${err.message}`);
    }
  }

  /** Operator override: share this exact content even though the audit blocked it. */
  async release(payload, actor = 'operator') {
    const r = (await this.recordFor(payload)) || { name: payload.name, sha256: payload.sha256, verdict: 'unaudited', findings: [] };
    const record = { ...r, released: true, releasedBy: actor, releasedAt: Date.now() };
    await this._save(payload.sha256, record);
    return record;
  }

  /** Latest verdict per skill name. */
  async list() {
    const byName = {};
    for (const r of Object.values(await this._records())) {
      if (!byName[r.name] || r.at > byName[r.name].at) byName[r.name] = r;
    }
    return Object.values(byName).sort((a, b) => a.name.localeCompare(b.name));
  }
}

let instance = null;
export function getShareAudit() {
  if (!instance) instance = new ShareAudit();
  return instance;
}
