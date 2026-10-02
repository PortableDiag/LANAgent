/**
 * Skill curator — background maintenance of the skill set (after hermes-agent's agent/curator.py).
 *
 * Runs when the agent has been idle, at most every few hours:
 *   - lifecycle: a managed skill unused for STALE_DAYS becomes `stale`; for ARCHIVE_DAYS, archived
 *     (moved to .archive/, recoverable). A skill's age counts from its last use, or from the first
 *     time the curator saw it — never from file dates, so old skills aren't archived on day one;
 *   - duplicates: two managed skills that mean the same thing are merged by the side-model into
 *     the more-used one, and the other is archived;
 *   - the operator profile: tidied when it outgrows its budget, and seeded once from memory.
 *
 * Only MANAGED skills are touched: ones the agent learned (source auto) or another agent taught
 * (source peer). The operator's own, bundled and Trellis-basket skills, and pinned ones, never are.
 * Nothing is deleted.
 */
import { logger } from '../../utils/logger.js';
import { getSkillsService } from './skillsService.js';
import { SKILL_WRITING_RULES } from './skillQuality.js';

export const STALE_DAYS = Number(process.env.SKILLS_STALE_DAYS) || 30;
export const ARCHIVE_DAYS = Number(process.env.SKILLS_ARCHIVE_DAYS) || 90;
const DUP_SIMILARITY = Number(process.env.SKILLS_DUPLICATE_SIMILARITY) || 0.92;
const MAX_MERGES = 2;
const DAY = 86400000;

export const isManaged = (s) => !s.bundled && ['auto', 'peer'].includes(s.meta?.source);

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class Curator {
  constructor({ service = getSkillsService(), providerManager = null, profile = null, memoryModel = null, notify = null, now = () => Date.now() } = {}) {
    Object.assign(this, { service, providerManager, profile, memoryModel, notify, now });
    this.lastRun = null;
  }

  /**
   * One maintenance pass. Returns what it changed or, with dryRun, what it would change
   * (plannedLifecycle / plannedMerges) without archiving, merging or touching usage state.
   * Never throws.
   */
  async run({ dryRun = false } = {}) {
    const report = {
      stale: [],
      archived: [],
      merged: [],
      plannedLifecycle: [],
      plannedMerges: [],
      profile: null,
      at: new Date(this.now()).toISOString()
    };

    try {
      await this.service.scan(true);
      const usage = await this.service.usage();
      const skills = [...this.service.skills.values()];

      // 1. lifecycle
      const firstSeen = [];
      const archiveCandidates = new Set();
      const lifecycleActions = [];

      for (const s of skills.filter(isManaged)) {
        const u = usage[s.name] || {};
        if (u.pinned) continue;
        const since = Date.parse(u.lastUsed || u.created || '') || null;
        if (!since) {
          firstSeen.push(s.name);
          lifecycleActions.push({
            action: 'initialize',
            name: s.name,
            state: 'active'
          });
          continue;
        }

        const idleDays = (this.now() - since) / DAY;
        if (idleDays >= ARCHIVE_DAYS) {
          const action = {
            action: 'archive',
            name: s.name,
            reason: `unused for ${Math.floor(idleDays)} days`
          };
          lifecycleActions.push(action);
          archiveCandidates.add(s.name);
          if (!dryRun) {
            await this.service.archive(s.name, { actor: 'curator', reason: action.reason });
            report.archived.push(s.name);
          }
        } else if (idleDays >= STALE_DAYS && u.state !== 'stale') {
          const action = {
            action: 'stale',
            name: s.name,
            reason: `unused for ${Math.floor(idleDays)} days`
          };
          lifecycleActions.push(action);
          if (!dryRun) {
            await this.service._updateUsage(x => { x[s.name] = { ...(x[s.name] || {}), state: 'stale' }; });
            report.stale.push(s.name);
          }
        }
      }

      if (firstSeen.length) {
        const t = new Date(this.now()).toISOString();
        if (!dryRun) {
          await this.service._updateUsage(x => { for (const n of firstSeen) x[n] = { uses: 0, ...(x[n] || {}), created: t, state: 'active' }; });
        }
      }

      if (dryRun) report.plannedLifecycle = lifecycleActions;

      // 2. duplicates among managed, active, unpinned skills
      const mergeResult = await this._mergeDuplicates(usage, {
        dryRun,
        excluded: archiveCandidates
      });
      report.merged = mergeResult.applied;
      if (dryRun) report.plannedMerges = mergeResult.planned;

      // 3. operator profile
      // Profile seeding and tidying can update operator state, so review runs leave it untouched.
      if (this.profile && !dryRun) {
        if (this.memoryModel) await this.profile.seedFromMemory(this.memoryModel, this.providerManager).catch(() => 0);
        report.profile = await this.profile.tidy(this.providerManager).catch(() => null);
      }
    } catch (err) {
      logger.warn(`[curator] run failed: ${err.message}`);
      report.error = err.message;
    }

    // A preview is not a maintenance pass; lastRun keeps describing the last real one.
    if (!dryRun) this.lastRun = report;
    const changed = report.archived.length + report.merged.length + report.stale.length;
    const planned = report.plannedLifecycle.length + report.plannedMerges.length;
    logger.info(`[curator] ${dryRun
      ? `${planned ? `planned ${planned} action${planned === 1 ? '' : 's'}` : 'nothing to plan'}`
      : `${changed ? `stale ${report.stale.length}, archived ${report.archived.length}, merged ${report.merged.length}` : 'nothing to change'}`
    }${report.profile?.changed ? `; profile ${report.profile.from}→${report.profile.chars} chars` : ''}`);

    if (!dryRun && (report.archived.length || report.merged.length) && this.notify) {
      await this.notify(report).catch(() => {});
    }
    return report;
  }

  async _mergeDuplicates(usage, { dryRun = false, excluded = new Set() } = {}) {
    const gen = this.providerManager?.generateAux || this.providerManager?.generateResponse;
    const result = { applied: [], planned: [] };
    if (!gen) return result;

    const pool = [...this.service.skills.values()].filter(s =>
      isManaged(s) && !usage[s.name]?.pinned && !excluded.has(s.name)
    );
    if (pool.length < 2) return result;

    const vecs = new Map();
    for (const s of pool) {
      try {
        vecs.set(s.name, await this.service.vectorFor(s));
      } catch (err) {
        logger.warn(`[curator] unable to vectorize ${s.name}: ${err.message}`);
        return result;
      }
    }

    const pairs = [];
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
      const sim = cosine(vecs.get(pool[i].name), vecs.get(pool[j].name));
      if (sim >= DUP_SIMILARITY) pairs.push({ a: pool[i], b: pool[j], sim });
    }

    pairs.sort((x, y) => y.sim - x.sim);
    const used = new Set();

    for (const { a, b, sim } of pairs) {
      if (result.applied.length + result.planned.length >= MAX_MERGES || used.has(a.name) || used.has(b.name)) continue;

      const [keep, drop] = (usage[a.name]?.uses || 0) >= (usage[b.name]?.uses || 0) ? [a, b] : [b, a];
      const prompt = `Two saved procedures (skills) of an AI agent overlap. If they describe the same task, merge them into ONE skill that keeps every useful step and every Gotchas line from both; answer JSON {"same":true,"description":"Use this skill when ...","body":"merged numbered steps, then ## Gotchas"}. If they are different tasks, answer {"same":false}.\n\n${SKILL_WRITING_RULES}\n\n### ${keep.name}\n${keep.description}\n\n${keep.body.slice(0, 4000)}\n\n### ${drop.name}\n${drop.description}\n\n${drop.body.slice(0, 4000)}`;

      // The provider manager already fails over between providers; a failed proposal just skips this pair.
      const res = await gen.call(this.providerManager, prompt, { maxTokens: 1500, temperature: 0, auxTask: 'skill-merge' }).catch(err => {
        logger.warn(`[curator] merge proposal failed for ${keep.name}/${drop.name}: ${err.message}`);
        return null;
      });

      let d = null;
      try { d = JSON.parse(String(res?.content || '').match(/\{[\s\S]*\}/)?.[0] || 'null'); } catch { d = null; }
      if (!d?.same || !d.body || !d.description) continue;

      const proposal = {
        kept: keep.name,
        archived: drop.name,
        similarity: sim,
        description: d.description,
        body: d.body
      };

      if (dryRun) {
        result.planned.push(proposal);
      } else {
        await this.service.update(keep.name, { description: d.description, body: d.body }, {
          actor: 'curator',
          reason: `merged ${drop.name} into it (similarity ${sim.toFixed(2)})`
        });
        await this.service.archive(drop.name, {
          actor: 'curator',
          reason: `merged into ${keep.name}`
        });
        result.applied.push({ kept: keep.name, archived: drop.name });
      }

      used.add(keep.name);
      used.add(drop.name);
    }

    return result;
  }
}

/**
 * Background schedule: first pass 10 minutes after start, then every `intervalHours`, each
 * deferred while the agent is busy (a conversation in the last 15 minutes).
 */
export function scheduleCurator(curator, { isIdle = () => true, intervalHours = Number(process.env.SKILLS_CURATOR_HOURS) || 6 } = {}) {
  if (String(process.env.SKILLS_CURATOR || 'true').toLowerCase() === 'false') return null;
  const tick = async () => {
    if (!isIdle()) { const t = setTimeout(tick, 30 * 60000); t.unref?.(); return; }
    await curator.run();
  };
  const first = setTimeout(tick, 10 * 60000);
  first.unref?.();
  const every = setInterval(tick, intervalHours * 3600000);
  every.unref?.();
  return { first, every };
}
