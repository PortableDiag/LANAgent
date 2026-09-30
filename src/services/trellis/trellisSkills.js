/**
 * trellis-notes: the document's shared Skills basket (trellis-web v0.71+, /api/skills).
 *
 * Skills are agentskills.io SKILL.md files kept as cards in a root basket `Skills`, one per
 * name, body verbatim. Agreed on relay 2754 #202-#207 / 2951 #99-#106:
 *   - PUBLISH: this agent posts one of its own skills. The server keeps it `proposed` until
 *     the owner approves it in a browser, or it is live at once when the document has
 *     auto-approve on (the default since web v0.71.3). Only skills tagged `trellis` are kept,
 *     so a published skill carries `tags: [trellis]`.
 *   - INSTALL: live skills from the basket are installed here, hash-checked against the
 *     server's canonical sha256 (the same formula as skillHash). Our trust rule:
 *       approved for exactly this content (approved_sha256 == sha256: the owner in a browser, or
 *       the owner's full-access key under web v0.72.1 `trust_full_keys`) → active;
 *       last written by the operator themself (person, signed-in session or their Telegram,
 *       from_key_owner) → active;
 *       auto_approved, written by anyone else → our own auto-approve setting decides, the
 *       same as a skill another agent teaches in a channel.
 *     A basket skill never replaces a bundled, local or P2P skill of the same name. One that
 *     stops being live is removed here; one the operator rejects here is not re-installed.
 */
import { getSkillsService, getAutoApprove, skillHash, parseSkill, renderSkill } from '../skills/skillsService.js';
import { sanitizeString } from '../p2p/sanitizer.js';
import { logger } from '../../utils/logger.js';

export const SKILLS_SYNC_MS = Math.max(60000, Number(process.env.TRELLIS_SKILLS_SYNC_MS) || 10 * 60 * 1000);
const SOURCE = 'trellis';

/** The origin recorded on an installed basket skill: which document it came from. */
export const basketOrigin = (docId) => `trellis:${docId || 'desktop'}`;

/** Did the operator themself write this (not a key, not a sharee)? */
export function writtenByOperator(w = {}) {
  return w.kind === 'person' && (w.via === 'session' || w.via === 'telegram') && w.from_key_owner === true;
}

/**
 * The local status for a basket entry: 'active', 'pending', or null (do not install).
 * @param {object} entry - a /api/skills entry
 * @param {{autoApprove: boolean, self: string}} opts
 */
export function basketSkillStatus(entry, { autoApprove, self = '' }) {
  if (!entry || entry.status !== 'live') return null;
  if (String(entry.last_writer?.name || '').toLowerCase() === String(self).toLowerCase()) return null;
  // An approval bound to this exact content. Only the owner's authority sets one: their browser
  // (`operator`) or, since web v0.72.1, their own document/account key (`"<agent> (full-access key)"`).
  if (entry.approved_sha256 && entry.approved_sha256 === entry.sha256) return 'active';
  if (writtenByOperator(entry.last_writer)) return 'active';
  return autoApprove ? 'active' : 'pending';
}

/** This agent's skills that may be published: its own (not learned from others), active, shareable. */
export async function publishableSkills(service = getSkillsService()) {
  await service.scan();
  return [...service.skills.values()].filter(s =>
    (s.meta?.status || 'active') === 'active'
    && !['peer', SOURCE].includes(s.meta?.source)
    && String(s.meta?.share ?? 'true').toLowerCase() !== 'false');
}

/** The SKILL.md to publish: sanitized, tagged `trellis`, with its canonical hash. */
export function basketSkillFile(skill, { author }) {
  const description = sanitizeString(String(skill.description || '')).replace(/\s*\n\s*/g, ' ').trim();
  const body = sanitizeString(String(skill.body || '')).trim();
  const sha256 = skillHash({ name: skill.name, description, body });
  const text = renderSkill({ name: skill.name, description, body, extra: { tags: '[trellis]', author } });
  return { name: skill.name, description, body, sha256, text, sanitized: body !== String(skill.body || '').trim() };
}

/** The known skill a sentence names, longest match first; null when none. */
export async function skillNamedIn(text, service = getSkillsService()) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  await service.scan();
  const hits = [...service.skills.keys()].filter(n => new RegExp(`(^|[^a-z0-9-])${n.replace(/[-]/g, '\\-')}([^a-z0-9-]|$)`).test(t));
  return hits.sort((a, b) => b.length - a.length)[0] || null;
}

export const SKILL_BASKET_COMMANDS = [
  { command: 'publishSkill', description: 'Publish one of this agent\'s own skills to the Trellis document\'s shared Skills basket (sanitized, tagged trellis); other agents in the document can then use it',
    usage: 'publishSkill({ skill: "append-to-card-section" })', examples: ['publish the humanizer skill to the trellis skills basket', 'share your skill in the trellis skills basket', 'put that skill in trellis skills'] },
  { command: 'listBasketSkills', description: 'List the skills in the Trellis document\'s shared Skills basket, with status (live, proposed, changed…) and who wrote each',
    usage: 'listBasketSkills({ active: false })', examples: ['what skills are in the trellis skills basket', 'list trellis skills', 'show the shared skills in trellis'] },
  { command: 'syncBasketSkills', description: 'Install the live skills from the Trellis Skills basket now (hash-checked, under this agent\'s trust rule) and remove ones that are no longer live',
    usage: 'syncBasketSkills', examples: ['sync skills from trellis', 'install the trellis skills basket', 'refresh skills from the trellis basket'] }
];

export const skillBasketActions = {
  async publishSkill({ skill, name: named, skillName, query, originalInput, _context } = {}) {
    const service = getSkillsService();
    let name = String(skill || named || skillName || '').trim();
    // The AI intent path can hand over only the sentence ("publish the X skill to …"):
    // take the skill it names — the longest known name that appears as a whole word.
    if (!name) name = (await skillNamedIn(query || originalInput || _context?.originalInput, service)) || '';
    if (!name) throw new Error('publishSkill needs the skill name (see: list skills).');
    const s = await service.get(name);
    if (!s) throw new Error(`No skill named "${name}".`);
    if (['peer', SOURCE].includes(s.meta?.source)) throw new Error(`"${name}" was learned from ${s.meta?.taught_by || 'another agent'} — only this agent's own skills are published.`);
    if ((s.meta?.status || 'active') !== 'active') throw new Error(`"${name}" is pending approval here; approve it first.`);
    if (String(s.meta?.share ?? 'true').toLowerCase() === 'false') throw new Error(`"${name}" is marked share: false.`);

    const file = basketSkillFile(s, { author: this._agentName() });
    const entry = await this._call('post', '/api/skills', { body: { skill: file.text } });
    const hashOk = entry?.sha256 === file.sha256;
    if (!hashOk) logger.warn(`[trellis-skills] published ${name}: server sha256 ${entry?.sha256} differs from ours ${file.sha256}`);
    logger.info(`[trellis-skills] published ${name} → card ${entry?.card} (${entry?.status})`);
    return {
      success: true,
      skill: name,
      card: entry?.card ?? null,
      status: entry?.status || null,
      hashMatches: hashOk,
      sanitized: file.sanitized,
      result: `Published \`${name}\` to the Trellis Skills basket (card ${entry?.card}), status ${entry?.status}` +
        (entry?.status === 'proposed' ? ' — it goes live when the document owner approves it.' : '.')
    };
  },

  async listBasketSkills({ active = false } = {}) {
    const data = await this._call('get', '/api/skills', { query: active ? { active: 'true' } : {} });
    const skills = (data?.skills || []).map(e => ({
      name: e.name, card: e.card, status: e.status, description: e.description,
      writer: e.last_writer?.name || null, autoApproved: !!e.auto_approved,
      approved: !!(e.approved_sha256 && e.approved_sha256 === e.sha256)
    }));
    return { success: true, basket: data?.node ?? data?.basket ?? null, count: skills.length, skills };
  },

  async syncBasketSkills() {
    const r = await syncBasketSkills(this);
    return { success: true, ...r, result: `Skills basket: ${r.installed.length} installed, ${r.updated.length} updated, ${r.removed.length} removed, ${r.skipped.length} skipped.` };
  }
};

/**
 * Install live basket skills in the current document and drop ones no longer live.
 * @param {object} plugin - the trellis-notes plugin (transport, document context)
 */
export async function syncBasketSkills(plugin, { service = getSkillsService() } = {}) {
  const docId = plugin.resolvedMode === 'web' ? plugin._currentDoc().id : null;
  const origin = basketOrigin(docId);
  const out = { document: docId, installed: [], updated: [], removed: [], skipped: [] };

  // A failed read says nothing about what is live: never remove on one.
  const data = await plugin._call('get', '/api/skills');
  const entries = Array.isArray(data?.skills) ? data.skills : [];
  const { enabled: autoApprove } = await getAutoApprove();
  const self = plugin._agentName();
  const live = new Set();

  for (const entry of entries) {
    const status = basketSkillStatus(entry, { autoApprove, self });
    if (!status) continue;
    live.add(entry.name);
    try {
      const existing = await service.get(entry.name);
      if (existing && (existing.bundled || existing.meta?.source !== SOURCE || existing.meta?.origin !== origin)) {
        out.skipped.push({ name: entry.name, reason: existing.bundled ? 'bundled skill of that name' : 'a skill of that name is already installed from elsewhere' });
        continue;
      }
      if (existing && existing.meta?.sha256 === entry.sha256) continue;
      if (!existing && await service.isPeerSkillRejected?.(entry.name, origin)) {
        out.skipped.push({ name: entry.name, reason: 'rejected by the operator' });
        continue;
      }

      const full = await plugin._call('get', `/api/skills/${encodeURIComponent(entry.name)}`);
      const parsed = parseSkill(full?.skill_md || '');
      const description = String(parsed?.meta?.description || '').replace(/\s*\n\s*/g, ' ').trim();
      const body = String(parsed?.body || '').trim();
      if (!parsed || parsed.meta?.name !== entry.name || skillHash({ name: entry.name, description, body }) !== entry.sha256) {
        out.skipped.push({ name: entry.name, reason: 'content does not match its sha256' });
        continue;
      }

      const saved = await service.create({
        name: entry.name, description, body, overwrite: !!existing,
        extra: {
          source: SOURCE, origin, trellis_card: String(entry.card ?? ''), sha256: entry.sha256,
          taught_by: String(entry.last_writer?.name || 'Trellis').substring(0, 80), status
        }
      });
      (existing ? out.updated : out.installed).push({ name: entry.name, status });
      logger.info(`[trellis-skills] ${existing ? 'updated' : 'installed'} ${entry.name} (${status}) from the Skills basket, card ${entry.card}`);
      if (!existing && plugin.listener?._askOperatorToApprove) {
        await plugin.listener._askOperatorToApprove(saved, `${entry.last_writer?.name || 'someone'} (Skills basket)`, entry.card).catch(() => {});
      }
    } catch (err) {
      out.skipped.push({ name: entry.name, reason: err.message });
    }
  }

  await service.scan(true);
  for (const s of [...service.skills.values()]) {
    if (s.meta?.source === SOURCE && s.meta?.origin === origin && !live.has(s.name)) {
      await service.remove(s.name, { remember: false });
      out.removed.push(s.name);
      logger.info(`[trellis-skills] removed ${s.name}: no longer live in the Skills basket`);
    }
  }
  return out;
}

/** Background sync over every followed document (web only). Never throws. */
export async function syncAllBasketSkills(plugin) {
  if (plugin.resolvedMode !== 'web') return;
  let docs = [];
  try { docs = await plugin._followedDocuments(); } catch (err) { logger.debug(`[trellis-skills] no documents: ${err.message}`); return; }
  for (const doc of docs) {
    try {
      const r = await plugin._runInDocument(doc, () => syncBasketSkills(plugin));
      if (r.installed.length || r.updated.length || r.removed.length) {
        logger.info(`[trellis-skills] ${doc.name}: ${r.installed.length} installed, ${r.updated.length} updated, ${r.removed.length} removed`);
      }
    } catch (err) {
      // 404 until the key can reach the document's Skills basket; not worth a warning each cycle.
      const quiet = err.status === 404 || err.status === 403;
      logger[quiet ? 'debug' : 'warn'](`[trellis-skills] sync skipped for ${doc.name}: ${err.message}`);
    }
  }
}
