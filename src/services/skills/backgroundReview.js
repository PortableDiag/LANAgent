/**
 * Background review — after a turn with the operator, a cheap side-model re-reads the exchange
 * and decides whether anything is worth keeping (after hermes-agent's agent/background_review.py):
 *
 *   - a CORRECTION of how the agent did something ("no, do it like this") → update the skill that
 *     was used, in place, with a history entry (skillsService.update, rollback-able);
 *   - a reusable procedure the operator explained → a new skill;
 *   - a durable fact or preference about the operator → the operator profile (userProfile.js);
 *   - otherwise nothing, which is the usual answer.
 *
 * It runs after the reply is sent, never blocks or changes it, uses the auxiliary model, and is
 * throttled per user and per day. Only the operator's own conversations are reviewed.
 */
import { logger } from '../../utils/logger.js';
import { getSkillsService } from './skillsService.js';
import { sanitizeString } from '../p2p/sanitizer.js';
import { SKILL_WRITING_RULES, addGotcha } from './skillQuality.js';

const MIN_GAP_MS = Number(process.env.SKILLS_REVIEW_MIN_GAP_MS) || 20000;
const MAX_PER_DAY = Number(process.env.SKILLS_REVIEW_MAX_PER_DAY) || 200;
const CORRECTION = /\b(no[,.!]? |not like that|that'?s (wrong|not right|incorrect)|wrong|instead|should have|you should|next time|don'?t|do not|always|never|remember (that|to)|from now on|actually|i prefer|i'?d rather)\b/i;

export function reviewEnabled() {
  return String(process.env.SKILLS_BACKGROUND_REVIEW || 'true').toLowerCase() !== 'false';
}

/** Worth a model call? Most turns are not: short chit-chat without a correction or a lesson. */
export function worthReviewing(input, reply) {
  const text = String(input || '').trim();
  if (!text || !String(reply || '').trim()) return false;
  if (CORRECTION.test(text)) return true;
  return text.length >= 60;
}

/** Parse the model's JSON decision; anything malformed means "nothing to keep". */
export function parseDecision(content) {
  const m = String(content || '').match(/\{[\s\S]*\}/);
  if (!m) return { skills: [], profile: [] };
  try {
    const d = JSON.parse(m[0]);
    return {
      skills: (Array.isArray(d.skills) ? d.skills : []).filter(s => s && ['create', 'update'].includes(s.op)).slice(0, 2),
      profile: (Array.isArray(d.profile) ? d.profile : []).map(x => String(x).trim()).filter(x => x && x.length <= 300).slice(0, 3)
    };
  } catch {
    return { skills: [], profile: [] };
  }
}

export class BackgroundReview {
  /**
   * @param {object} deps
   * @param {object} deps.providerManager - generateAux (or generateResponse) for the review
   * @param {object} [deps.service] - SkillsService
   * @param {object} [deps.profile] - UserProfile ({text(), add(lines, source)})
   * @param {(items: object[]) => Promise<void>} [deps.notify] - batched notice to the operator
   */
  constructor({ providerManager, service = getSkillsService(), profile = null, notify = null }) {
    this.providerManager = providerManager;
    this.service = service;
    this.profile = profile;
    this.notify = notify;
    this.lastRun = new Map();
    this.day = '';
    this.count = 0;
    this.running = new Set();
  }

  _allowed(userId) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.count = 0; }
    if (this.count >= MAX_PER_DAY) return false;
    if (Date.now() - (this.lastRun.get(userId) || 0) < MIN_GAP_MS) return false;
    if (this.running.has(userId)) return false;
    return true;
  }

  /** Fire-and-forget entry point. Never throws. */
  consider({ userId, input, reply, recent = [] }) {
    if (!reviewEnabled() || !this.providerManager || !worthReviewing(input, reply)) return;
    const uid = String(userId || 'default');
    if (!this._allowed(uid)) return;
    this.lastRun.set(uid, Date.now());
    this.count++;
    this.running.add(uid);
    this.review({ input, reply, recent })
      .catch(err => logger.debug(`Background review failed: ${err.message}`))
      .finally(() => this.running.delete(uid));
  }

  async review({ input, reply, recent = [] }) {
    await this.service.scan();
    // The skills that were in front of the model for this request: a correction usually concerns one.
    const used = await this.service.match(input, { limit: 2 }).catch(() => []);
    const all = [...this.service.skills.values()].filter(s => (s.meta?.status || 'active') === 'active');
    const catalog = all.slice(0, 80).map(s => `- ${s.name}: ${String(s.description).slice(0, 140)}`).join('\n');
    const usedText = used.map(s => `### ${s.name}\n${s.description}\n\n${String(s.body).slice(0, 3000)}`).join('\n\n') || '(none)';
    const profileText = this.profile ? (await this.profile.text()).slice(0, 1500) : '';
    const history = recent.slice(-6).map(m => `${m.role === 'user' ? 'Operator' : 'Agent'}: ${String(m.content).slice(0, 600)}`).join('\n');

    const prompt = `You maintain an AI agent's long-term learning. Review the latest exchange between the agent and its operator and decide whether anything is worth keeping. Most exchanges need nothing: answer {"skills":[],"profile":[]} unless there is a clear, durable lesson.

Keep only:
1. A CORRECTION of how the agent did a task ("no, do it like this", "next time...", "you should have..."): op "update" on the skill below that it concerns (exact name), with "gotcha": one concrete line that prevents the mistake (it is added to the skill's Gotchas section). Send a full "body" ONLY if the steps themselves were wrong, and then keep every step that was right.
2. A reusable PROCEDURE the operator explained step by step, that no existing skill covers: op "create".
3. A durable FACT or PREFERENCE about the operator (standing rules, preferences, how they like things done): add a short line to "profile". Not transient requests, not secrets, keys, passwords or addresses.

Skills in use for this request (full text):
${usedText}

All skill names:
${catalog || '(none)'}

${SKILL_WRITING_RULES}

Current operator profile:
${profileText || '(empty)'}

Recent conversation:
${history || '(none)'}

Latest exchange:
Operator: ${String(input).slice(0, 2000)}
Agent: ${String(reply).slice(0, 2000)}

Answer JSON only:
{"skills":[{"op":"update","name":"existing-skill","gotcha":"one concrete line that prevents the mistake","body":"ONLY if the steps were wrong: the full corrected procedure","reason":"what the operator corrected"} | {"op":"create","name":"kebab-case-name","description":"Use this skill when ...","body":"numbered steps, then ## Gotchas"}], "profile":["short durable fact about the operator"]}`;

    const gen = this.providerManager.generateAux || this.providerManager.generateResponse;
    const res = await gen.call(this.providerManager, prompt, { maxTokens: 1500, temperature: 0.1, auxTask: 'background-review' });
    const decision = parseDecision(res?.content);
    const applied = [];

    for (const s of decision.skills) {
      try {
        // Local skills keep their text as written (a corrected ops procedure may need a path or
        // host); sharing a skill with other agents sanitizes it on the way out.
        const description = s.description ? String(s.description).slice(0, 1024) : undefined;
        const body = s.body ? String(s.body) : undefined;
        if (s.op === 'update') {
          const current = await this.service.get(String(s.name || ''));
          if (!current) continue;
          if (current.meta?.source === 'trellis') continue;   // owned by the Skills basket sync
          // agentskills.io: "add the correction to the gotchas section" — the steps are rewritten
          // only when the reviewer says they were wrong, and even then the gotcha is kept.
          let nextBody = body || current.body;
          if (s.gotcha) nextBody = addGotcha(nextBody, String(s.gotcha).slice(0, 400));
          if (nextBody === current.body && !description) continue;
          await this.service.update(current.name, { description, body: nextBody }, { actor: 'background-review', reason: s.reason || s.gotcha || 'correction in conversation' });
          applied.push({ kind: 'skill-update', name: current.name, reason: s.reason || '' });
        } else if (s.op === 'create' && description && body) {
          const saved = await this.service.create({ name: s.name, description, body, extra: { source: 'auto', learned_via: 'background-review' } });
          if (saved) applied.push({ kind: 'skill-create', name: saved.name, description: saved.description });
        }
      } catch (err) {
        logger.debug(`Background review could not apply ${s.op} ${s.name}: ${err.message}`);
      }
    }
    if (decision.profile.length && this.profile) {
      const added = await this.profile.add(decision.profile.map(x => sanitizeString(x)), 'background-review').catch(() => []);
      for (const line of added) applied.push({ kind: 'profile', text: line });
    }
    if (applied.length) {
      logger.info(`[background-review] kept: ${applied.map(a => a.kind === 'profile' ? `profile "${a.text.slice(0, 60)}"` : `${a.kind} ${a.name}`).join('; ')}`);
      if (this.notify) await this.notify(applied).catch(() => {});
    }
    return applied;
  }
}
