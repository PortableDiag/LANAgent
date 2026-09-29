import { logger } from '../../utils/logger.js';
import { sanitizeString } from '../p2p/sanitizer.js';
import {
  getSkillsService, parseSkill, renderSkill, skillHash, installPeerSkill, getAutoApprove
} from './skillsService.js';

/**
 * Teaching skills to other agents in Trellis channels (the Skynet P2P network has its own
 * path, p2p/skillSharing.js). Before this, an agent could only LEARN in a channel: another
 * agent's steps became a pending skill, but asked "how do you do X?", the agent answered
 * from general model knowledge — its own skills never reached the conversation.
 *
 * When it teaches — only in a message addressed to this agent, from another AGENT (the
 * operator's own messages go through the normal command pipeline, where `teachSkill` does
 * the same on request):
 *   - asked for a procedure it has a skill for ("how do you triage an inbox?", "send me your
 *     humanizer skill") → it sends the skill;
 *   - asked what it knows ("what skills do you have?") → it lists them;
 *   - an agent describes a problem one of its skills solves → it OFFERS the skill, once, and
 *     sends it only when that agent says yes. No skill is pushed unasked.
 *
 * What travels: a short summary in the message, and the skill itself as an attached
 * `<name>.SKILL.md` (the agentskills.io format). A file, not message text, because a
 * SKILL.md begins with `---` lines, which end a Trellis message (the server refuses them),
 * and because skills run past a message's length. The frontmatter carries `sha256` over the
 * sanitized content; another LANAgent installs it exactly (receiveSkillFiles), and any
 * other agent can read it as a standard SKILL.md.
 *
 * What is shared is what P2P shares: active skills not marked `share: false`, sanitized
 * (IPs, paths, emails and key-shaped strings redacted). Bundled skills are included: an
 * agent from another framework will not have them.
 *
 * Limits: TEACH_PER_CHANNEL_DAY teachings and OFFERS_PER_CHANNEL_DAY offers per channel per
 * UTC day; an offer is never repeated to the same agent for the same version of a skill; an
 * open offer expires after OFFER_TTL_MS. Off with SKILLS_TRELLIS_TEACH=false or the
 * `skills.trellisTeach` setting; offers alone off with SKILLS_TRELLIS_OFFER=false.
 */

export const TEACH_PER_CHANNEL_DAY = Number(process.env.SKILLS_TRELLIS_TEACH_PER_DAY) || 5;
export const OFFERS_PER_CHANNEL_DAY = Number(process.env.SKILLS_TRELLIS_OFFERS_PER_DAY) || 2;
export const OFFER_TTL_MS = 24 * 60 * 60 * 1000;
// An offer needs a clearly relevant skill: a lift well above the plain match threshold
// (0.05; measured real requests 0.073-0.163, greetings at most 0.031).
export const OFFER_MIN_LIFT = Number(process.env.SKILLS_TRELLIS_OFFER_MIN_LIFT) || 0.08;
const LEDGER_KEY = 'skills.trellisTeachLog';
const LEDGER_MAX = 500;
const SETTING_KEY = 'skills.trellisTeach';

const LIST_RE = /\b(what|which)\s+(skills|procedures|playbooks)\b|\b(list|show)\s+(me\s+)?(your\s+)?(skills|procedures|playbooks)\b|\bskills\s+(do\s+)?you\s+(have|know)\b/i;
const ACCEPT_RE = /^\W*(yes|yeah|yep|yup|sure|please|ok(ay)?|y|send( it| that| me)?|go ahead|do it|share it|that would help|i'?d like (that|it))\b/i;
const DECLINE_RE = /^\W*(no|nope|no thanks|not now|nah|don'?t)\b/i;
const HINT_RE = /\b(how (do|would|can|should) (you|i|we)|teach|skill|procedure|playbook|steps?|recipe|walk me through|what'?s the (process|way)|stuck|struggl|can'?t (get|figure)|keeps? failing|not working|help)\b/i;

/** Is Trellis skill teaching on? env SKILLS_TRELLIS_TEACH wins, then the setting, then on. */
export async function getTrellisTeaching() {
  const env = String(process.env.SKILLS_TRELLIS_TEACH || '').toLowerCase();
  const offers = String(process.env.SKILLS_TRELLIS_OFFER || 'true').toLowerCase() !== 'false';
  if (env === 'false' || env === 'true') return { enabled: env === 'true', offers, source: 'env' };
  try {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    const v = await SystemSettings.getSetting(SETTING_KEY, true);
    return { enabled: v !== false && v !== 'false', offers, source: 'setting' };
  } catch {
    return { enabled: true, offers, source: 'default' };
  }
}

export async function setTrellisTeaching(enabled) {
  const { SystemSettings } = await import('../../models/SystemSettings.js');
  await SystemSettings.setSetting(SETTING_KEY, !!enabled, 'Teach skills to other agents in Trellis channels when they ask or need one', 'skills');
  return getTrellisTeaching();
}

/** Skills that may be taught: active and not marked `share: false` (bundled included). */
export async function teachableSkills(service = getSkillsService()) {
  await service.scan();
  return [...service.skills.values()].filter(s =>
    (s.meta?.status || 'active') === 'active'
    && String(s.meta?.share ?? 'true').toLowerCase() !== 'false');
}

/** The wire form of a skill: sanitized, hashed, rendered as a SKILL.md file. */
export function packageSkill(skill, { teacher = process.env.AGENT_NAME || 'LANAgent' } = {}) {
  const description = sanitizeString(String(skill.description || '')).replace(/\s*\n\s*/g, ' ').trim();
  const body = sanitizeString(String(skill.body || '')).trim();
  const sha256 = skillHash({ name: skill.name, description, body });
  const fileText = renderSkill({
    name: skill.name, description, body,
    extra: { sha256, origin_name: skill.meta?.origin_name || teacher, taught_by: teacher, license: skill.meta?.license || 'shared by its author' }
  });
  return { name: skill.name, description, body, sha256, fileName: `${skill.name}.SKILL.md`, fileText };
}

/** The message that carries a skill: a readable summary; the SKILL.md rides as a file. */
export function teachMessage(pkg, { to = null, note = '' } = {}) {
  const lines = [
    `${to ? `@${to} ` : ''}${note ? `${note}\n\n` : ''}Here's my skill \`${pkg.name}\`: ${pkg.description}`,
    '',
    `The full procedure is attached as ${pkg.fileName} (standard SKILL.md). A LANAgent saves it as a skill; any other agent can read the file.`
  ];
  return { text: lines.join('\n'), files: [{ name: pkg.fileName, data_base64: Buffer.from(pkg.fileText, 'utf8').toString('base64') }] };
}

// ── Ledger: what was taught and offered, to whom, where ─────────────────────────────────

async function readLedger() {
  try {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    const v = await SystemSettings.getSetting(LEDGER_KEY, []);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function writeLedger(entries) {
  try {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    await SystemSettings.setSetting(LEDGER_KEY, entries.slice(-LEDGER_MAX), 'Skills taught and offered to other agents in Trellis channels', 'skills');
  } catch (err) {
    logger.debug(`[skill-teach] ledger not saved: ${err.message}`);
  }
}

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

export class SkillTeacher {
  /**
   * @param {object} deps
   * @param {object} deps.providerManager  for the one short classification call
   * @param {object} [deps.service]        skills service
   * @param {Function} [deps.ledger]       { read, write } override (tests)
   * @param {Function} [deps.now]
   */
  constructor({ providerManager = null, service = null, ledger = null, now = () => Date.now(), teacher = null } = {}) {
    this.providerManager = providerManager;
    this._service = service;
    this.ledger = ledger || { read: readLedger, write: writeLedger };
    this.now = now;
    this.teacher = teacher || process.env.AGENT_NAME || 'LANAgent';
  }

  get service() { return this._service || getSkillsService(); }

  /**
   * Decide what, if anything, to teach in answer to `message` (another agent's, addressed
   * to us) in channel `card`. Returns null, or { action, text, files?, skill?, replaceReply }.
   *   replaceReply: true → this IS the answer (teach/list); false → append to the reply (offer).
   */
  async consider({ card, message, group = false }) {
    const state = await getTrellisTeaching();
    if (!state.enabled) return null;
    const from = String(message?.from || '');
    const text = String(message?.text || '').trim();
    if (!from || !text) return null;
    const to = group ? from : null;
    const skills = await teachableSkills(this.service);
    if (!skills.length) return null;
    const entries = await this.ledger.read();

    // 1. Our open offer to this agent in this channel, answered yes/no
    const offer = this._openOffer(entries, card, from);
    if (offer) {
      if (DECLINE_RE.test(text)) {
        await this._record(entries, { kind: 'declined', card, agent: from, skill: offer.skill, sha256: offer.sha256 });
        return null;
      }
      if (ACCEPT_RE.test(text) && text.length < 200) {
        const skill = skills.find(s => s.name === offer.skill);
        if (skill) return this._teach(entries, { card, from, skill, to, note: 'Sure.' });
      }
    }

    // 2. "What skills do you have?"
    if (LIST_RE.test(text)) {
      const shown = skills.slice(0, 30).map(s => `- \`${s.name}\`: ${sanitizeString(String(s.description)).slice(0, 160)}`);
      return {
        action: 'list',
        replaceReply: true,
        text: `${to ? `@${to} ` : ''}Skills I can share (ask for any by name and I'll send the SKILL.md):\n${shown.join('\n')}${skills.length > 30 ? `\n…and ${skills.length - 30} more.` : ''}`
      };
    }

    // 3. A skill named outright ("send me your humanizer skill")
    const named = skills.find(s => new RegExp(`(^|[^\\w-])${s.name.replace(/[-]/g, '[- ]')}([^\\w-]|$)`, 'i').test(text));

    // 4. Otherwise only look further when the message could be about a procedure at all —
    //    no embedding or model call for ordinary chat.
    if (!named && !HINT_RE.test(text)) return null;
    const matches = named ? [{ skill: named, score: null, lift: 1 }]
      : await this.service.match(text, { limit: 2, withScores: true, skills }).catch(() => []);
    if (!matches.length) return null;
    const best = matches[0];

    const intent = named && /\b(send|share|teach|give)\b/i.test(text) ? 'request' : await this._classify(text, best.skill);
    if (intent === 'request') return this._teach(entries, { card, from, skill: best.skill, to });
    if (intent === 'problem' && state.offers && (best.lift === null || best.lift >= OFFER_MIN_LIFT)) {
      return this._offer(entries, { card, from, skill: best.skill, to });
    }
    return null;
  }

  /** Teach `skillName` in `card` on the operator's instruction (trellis-notes `teachSkill`). */
  async teachOnRequest({ card, skillName, to = null }) {
    const skills = await teachableSkills(this.service);
    const skill = skills.find(s => s.name === skillName)
      || skills.find(s => same(s.name, String(skillName).replace(/\s+/g, '-')));
    if (!skill) {
      const all = skills.map(s => s.name).join(', ');
      throw new Error(`No shareable skill "${skillName}". Shareable: ${all || 'none'}.`);
    }
    const entries = await this.ledger.read();
    const pkg = packageSkill(skill, { teacher: this.teacher });
    await this._record(entries, { kind: 'taught', card, agent: to || '*', skill: skill.name, sha256: pkg.sha256, by: 'operator' });
    return { action: 'teach', skill: skill.name, ...teachMessage(pkg, { to }) };
  }

  async _teach(entries, { card, from, skill, to, note = '' }) {
    const today = dayOf(this.now());
    const taughtToday = entries.filter(e => e.kind === 'taught' && String(e.card) === String(card) && dayOf(e.at) === today).length;
    if (taughtToday >= TEACH_PER_CHANNEL_DAY) {
      logger.info(`[skill-teach] card ${card}: ${taughtToday} skills taught today, limit reached — not sending ${skill.name}`);
      return null;
    }
    const pkg = packageSkill(skill, { teacher: this.teacher });
    await this._record(entries, { kind: 'taught', card, agent: from, skill: skill.name, sha256: pkg.sha256 });
    logger.info(`[skill-teach] teaching ${skill.name} to ${from} in card ${card}`);
    return { action: 'teach', skill: skill.name, replaceReply: true, ...teachMessage(pkg, { to, note }) };
  }

  async _offer(entries, { card, from, skill, to }) {
    const pkg = packageSkill(skill, { teacher: this.teacher });
    const before = entries.some(e => (e.kind === 'offered' || e.kind === 'taught' || e.kind === 'declined')
      && same(e.agent, from) && e.skill === skill.name && e.sha256 === pkg.sha256);
    if (before) return null;
    const today = dayOf(this.now());
    const offeredToday = entries.filter(e => e.kind === 'offered' && String(e.card) === String(card) && dayOf(e.at) === today).length;
    if (offeredToday >= OFFERS_PER_CHANNEL_DAY) return null;
    await this._record(entries, { kind: 'offered', card, agent: from, skill: skill.name, sha256: pkg.sha256 });
    logger.info(`[skill-teach] offering ${skill.name} to ${from} in card ${card}`);
    return {
      action: 'offer',
      skill: skill.name,
      replaceReply: false,
      text: `I have a skill for this, \`${skill.name}\`: ${pkg.description} Want it? Reply yes and I'll send the SKILL.md.`
    };
  }

  _openOffer(entries, card, from) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (String(e.card) !== String(card) || !same(e.agent, from)) continue;
      if (e.kind === 'offered' && this.now() - e.at < OFFER_TTL_MS) return e;
      if (e.kind === 'taught' || e.kind === 'declined' || e.kind === 'offered') return null; // the newest one decides
    }
    return null;
  }

  async _record(entries, entry) {
    entries.push({ ...entry, card: String(entry.card), at: this.now() });
    await this.ledger.write(entries);
  }

  /** One short classification: is the agent asking for the procedure, or describing a problem it solves? */
  async _classify(text, skill) {
    const pm = this.providerManager;
    if (!pm) return 'other';
    const prompt = `Another AI agent sent this message. We have a documented procedure called "${skill.name}": ${String(skill.description).slice(0, 300)}

Message:
${text.slice(0, 1500)}

Answer with ONE word:
request - the agent asks how to do what this procedure covers, or asks for the procedure/steps/skill
problem - the agent describes a task or problem this procedure would clearly help with, without asking for it
other - anything else (the procedure is not really relevant, or it is small talk, thanks, a status report)`;
    try {
      const res = await (pm.generateAux || pm.generateResponse).call(pm, prompt, { maxTokens: 5, temperature: 0, auxTask: 'skill-teach' });
      const word = String(res?.content || '').trim().toLowerCase().match(/request|problem|other/)?.[0];
      return word || 'other';
    } catch (err) {
      logger.debug(`[skill-teach] classification failed: ${err.message}`);
      return 'other';
    }
  }
}

/**
 * Save the SKILL.md files attached to another agent's message. Returns the installed skills
 * ({ saved, status, skill, reason }) — empty when the message carried none.
 * @param {object} args
 * @param {Function} args.fetch  (index) → Promise<Buffer|string>: the attachment's bytes
 */
export async function receiveSkillFiles({ message, fetch, service = getSkillsService() }) {
  const files = (Array.isArray(message?.files) ? message.files : [])
    .filter(f => f && f.kind !== 'image' && /\.skill\.md$|^skill\.md$/i.test(String(f.name || '')));
  const out = [];
  for (const f of files.slice(0, 3)) {
    try {
      if (Number(f.bytes) > 60000) { out.push({ saved: false, reason: `${f.name} is too large` }); continue; }
      const raw = await fetch(Number(f.index));
      const parsed = parseSkill(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
      if (!parsed?.meta?.name) { out.push({ saved: false, reason: `${f.name} is not a SKILL.md` }); continue; }
      const name = String(parsed.meta.name).trim().toLowerCase();
      const description = String(parsed.meta.description || '').replace(/\s*\n\s*/g, ' ').trim();
      const body = parsed.body.trim();
      // A LANAgent sends the hash of what it sent; an agent from elsewhere sends a plain
      // SKILL.md. A hash that does not match means the file changed on the way: refused.
      const sha256 = parsed.meta.sha256 || skillHash({ name, description, body });
      const auto = (await getAutoApprove()).enabled;
      const res = await installPeerSkill({
        service,
        skill: { name, description, body, sha256, originName: parsed.meta.origin_name || message.from },
        trusted: auto,
        from: { name: String(message.from || 'agent') },
        via: 'trellis'
      });
      out.push({ ...res, name });
    } catch (err) {
      out.push({ saved: false, reason: err.message });
    }
  }
  return out;
}
