import { BasePlugin } from '../core/basePlugin.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import { getSkillsService, SKILLS_DIR } from '../../services/skills/skillsService.js';

/**
 * Manage skills: markdown procedures (agentskills.io SKILL.md format) under data/skills/.
 * Matching skills are applied automatically in chat and multi-step reasoning; this plugin
 * lists, shows, saves and deletes them.
 */
export default class SkillsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'skills';
    this.version = '1.0.0';
    this.description = 'Saved procedures (skills) the agent follows for recurring tasks';

    this.commands = [
      {
        command: 'list',
        description: 'List the skills (saved procedures) the agent knows',
        usage: 'list()',
        examples: ['what skills do you have', 'list your skills', 'show saved procedures']
      },
      {
        command: 'view',
        description: 'Show one skill in full',
        usage: 'view({ name: "rotate-vpn-exit" })',
        examples: ['show the rotate-vpn-exit skill', 'how does your backup skill go']
      },
      {
        command: 'create',
        description: 'Save a procedure as a skill so it is followed next time',
        usage: 'create({ name: "restart-media-stack", description: "When and how to restart the media containers", body: "1. ...\\n2. ..." })',
        examples: ['save this as a skill: to restart the media stack, first stop jellyfin then...', 'remember this procedure as a skill']
      },
      {
        command: 'delete',
        description: 'Delete a skill',
        usage: 'delete({ name: "old-skill" })',
        examples: ['delete the old-skill skill', 'forget the backup skill']
      },
      {
        command: 'approve',
        description: 'Approve a pending skill (one another agent taught) so it is used from now on',
        usage: 'approve({ name: "post-image-card" })',
        examples: ['approve the skill', 'approve skill post-image-card', 'yes use the skill that outrider taught you']
      },
      {
        command: 'approveAll',
        description: 'Approve every pending skill (all the ones other agents taught) at once',
        usage: 'approveAll',
        examples: ['approve all skills', 'approve all pending skills', 'accept every skill the agents taught you']
      },
      {
        command: 'setAutoApprove',
        description: 'Turn automatic approval of skills other agents teach in Trellis channels on or off (on by default); turning it on also approves any already pending',
        usage: 'setAutoApprove({ enabled: true })',
        examples: ['turn on auto approve skills', 'auto approve skills from other agents', 'turn off skill auto approval', 'stop auto approving skills', 'is skill auto approve on']
      },
      {
        command: 'setSharing',
        description: 'Turn skill sharing with other agents on the Skynet P2P network on or off (on by default), or set the trust score a peer needs for its skills to be used without approval',
        usage: 'setSharing({ enabled: false })  or  setSharing({ minTrustScore: 60 })',
        examples: ['turn off skill sharing', 'stop sharing skills with other agents', 'turn on skill sharing', 'is skill sharing on', 'set the skill sharing trust score to 60']
      },
      {
        command: 'setTrellisTeaching',
        description: 'Turn teaching skills to other agents in Trellis channels on or off (on by default): when an agent asks for a procedure it gets the skill as a SKILL.md, and an agent describing a problem a skill solves is offered it',
        usage: 'setTrellisTeaching({ enabled: false })',
        examples: ['stop teaching skills in trellis', 'turn off skill teaching in trellis channels', 'turn on trellis skill teaching', 'is trellis skill teaching on']
      },
      {
        command: 'update',
        description: 'Change a skill\'s steps or description in place (history kept; roll back with rollback)',
        usage: 'update({ name: "send-report", body: "1. ...", description: "optional" })',
        examples: ['update the send-report skill', 'change step 2 of the backup skill', 'fix the skill so it does X instead']
      },
      {
        command: 'history',
        description: 'Show the change history of a skill (who changed it, when, why)',
        usage: 'history({ name: "send-report" })',
        examples: ['how did the backup skill change', 'show the history of that skill', 'who changed the skill']
      },
      {
        command: 'rollback',
        description: 'Undo the most recent change to a skill',
        usage: 'rollback({ name: "send-report" })',
        examples: ['roll back the skill change', 'undo the last change to the backup skill', 'revert that skill']
      },
      {
        command: 'archive',
        description: 'Take a skill out of use (moved to the archive, restorable)',
        usage: 'archive({ name: "old-skill" })',
        examples: ['archive the blue frog skill', 'stop using that skill but keep it']
      },
      {
        command: 'restore',
        description: 'Bring an archived skill back into use',
        usage: 'restore({ name: "old-skill" })',
        examples: ['restore the archived skill', 'bring back the blue frog skill']
      },
      {
        command: 'pin',
        description: 'Pin or unpin a skill: the curator never archives, merges or marks a pinned skill stale',
        usage: 'pin({ name: "backup", pinned: true })',
        examples: ['pin the backup skill', 'unpin that skill', 'keep that skill forever']
      },
      {
        command: 'shareAudit',
        description: 'Show which skills passed the privacy audit that runs before a skill is shared with other agents, and why any were kept private; with a name, audit that skill now',
        usage: 'shareAudit({ name?: "backup" })',
        examples: ['which skills are safe to share', 'why was that skill kept private', 'audit the backup skill for sharing', 'show the skill privacy audit']
      },
      {
        command: 'releaseForSharing',
        description: 'Share a skill the privacy audit kept private (operator override, for its current content only)',
        usage: 'releaseForSharing({ name: "backup" })',
        examples: ['release skill backup for sharing', 'share that skill anyway', 'the backup skill is fine to share']
      },
      {
        command: 'installFromUrl',
        description: 'Install a skill (SKILL.md) from GitHub or a URL; it waits for approval before it is used',
        usage: 'installFromUrl({ url: "https://github.com/owner/repo/tree/main/skills/some-skill" })',
        examples: ['install the skill from this github link', 'add this skill from github', 'install skill from url']
      },
      {
        command: 'evaluate',
        description: 'Test whether a skill is used for the right requests: realistic requests that should use it and near-misses that should not, run through the skill matcher',
        usage: 'evaluate({ name: "humanizer" })',
        examples: ['test whether the humanizer skill triggers correctly', 'does that skill get used when it should', 'evaluate the skill description']
      },
      {
        command: 'curate',
        description: 'Run skill housekeeping now: mark unused learned skills stale, archive long-unused ones, merge duplicates, tidy the profile',
        usage: 'curate',
        examples: ['clean up your skills', 'run skill housekeeping', 'curate your skills']
      },
      {
        command: 'profile',
        description: 'Show, add to, or replace the profile the agent keeps about its operator (it is part of every prompt)',
        usage: 'profile()  |  profile({ add: "I prefer short answers" })  |  profile({ set: "- ...\\n- ..." })',
        examples: ['what do you know about me', 'show my profile', 'remember that I prefer short answers', 'add to my profile']
      },
      {
        command: 'reject',
        description: 'Reject (delete) a pending skill another agent taught',
        usage: 'reject({ name: "post-image-card" })',
        examples: ['reject skill post-image-card', 'discard that pending skill', 'do not use the skill outrider taught']
      }
    ];
  }

  async initialize() {
    this.service = getSkillsService();
    const skills = await this.service.list();
    this.logger.info(`Skills: ${skills.length} loaded from ${SKILLS_DIR}`);
    this.initialized = true;
  }

  async execute(params) {
    const { action, ...data } = params;
    this.validateParams(params, {
      action: { required: true, type: 'string', enum: this.commands.map(c => c.command) }
    });
    const service = this.service || getSkillsService();

    if (params.needsParameterExtraction && this.agent.providerManager && !['list', 'approveAll', 'setAutoApprove', 'curate', 'shareAudit'].includes(action)) {
      Object.assign(data, await this.extractParameters(params.originalInput || params.input, action));
    }

    try {
      switch (action) {
        case 'list': {
          const skills = await service.list();
          if (!skills.length) return { success: true, count: 0, result: `No skills yet. Add one with "save this as a skill…" or drop a SKILL.md into ${SKILLS_DIR}.` };
          const usage = await service.usage();
          const { lintSkill } = await import('../../services/skills/skillQuality.js');
          for (const sk of skills) {
            const full = await service.get(sk.name);
            sk.warnings = full ? lintSkill(full) : [];
            const u = usage[sk.name] || {};
            Object.assign(sk, { uses: u.uses || 0, lastUsed: u.lastUsed || null, state: u.state || 'active', pinned: !!u.pinned });
          }
          const archived = data.includeArchived ? await service.archived() : undefined;
          return {
            success: true,
            count: skills.length,
            skills,
            ...(archived ? { archived } : {}),
            result: `${skills.length} skill(s):\n` + skills.map(s => `• ${s.name}${s.status === 'pending' ? ` (PENDING — taught by ${s.taughtBy || 'another agent'}; "approve skill ${s.name}" to use it)` : s.source === 'auto' ? ' (learned)' : s.source === 'peer' ? ` (taught by ${s.taughtBy || 'another agent'})` : ''}: ${s.description}`).join('\n')
          };
        }
        case 'view': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const skill = await service.get(data.name);
          if (!skill) return { success: false, error: `No skill named "${data.name}"` };
          return { success: true, skill: { name: skill.name, description: skill.description, body: skill.body }, result: `${skill.name}: ${skill.description}\n\n${skill.body}` };
        }
        case 'create': {
          const skill = await service.create({ name: data.name, description: data.description, body: data.body, overwrite: data.overwrite === true });
          return { success: true, result: `Saved skill "${skill.name}". It will be used for requests like: ${skill.description}` };
        }
        case 'approve': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const skill = await service.approve(data.name);
          return skill ? { success: true, result: `Approved skill "${skill.name}" — I'll use it for: ${skill.description}` } : { success: false, error: `No skill named "${data.name}"` };
        }
        case 'approveAll': {
          const names = await service.approveAll();
          return names.length
            ? { success: true, approved: names, result: `Approved ${names.length} skill(s): ${names.join(', ')}.` }
            : { success: true, approved: [], result: 'No skills are waiting for approval.' };
        }
        case 'setAutoApprove': {
          const { setAutoApprove, getAutoApprove } = await import('../../services/skills/skillsService.js');
          if (data.enabled === undefined || data.enabled === null) {
            const cur = await getAutoApprove();
            return { success: true, enabled: cur.enabled, result: `Skill auto-approval is ${cur.enabled ? 'ON' : 'OFF'}${cur.source === 'env' ? ' (set by SKILLS_AUTO_APPROVE in .env)' : ''}.` };
          }
          const on = data.enabled === true || /^(true|on|yes|1|enable)/i.test(String(data.enabled));
          const state = await setAutoApprove(on);
          const approved = on ? await service.approveAll() : [];
          const envNote = state.source === 'env' ? ' Note: SKILLS_AUTO_APPROVE in .env overrides this setting.' : '';
          return { success: true, enabled: on, approved, result: `Skill auto-approval is now ${on ? 'ON — skills other agents teach are used at once; you are still told, with a Reject button' : 'OFF — new skills from other agents wait for your approval'}.${approved.length ? ` Approved the ${approved.length} already pending: ${approved.join(', ')}.` : ''}${envNote}` };
        }
        case 'setSharing': {
          const { setSkillSharing, getSkillSharing } = await import('../../services/skills/skillsService.js');
          const hasEnabled = data.enabled !== undefined && data.enabled !== null && data.enabled !== '';
          const hasScore = data.minTrustScore !== undefined && data.minTrustScore !== null && data.minTrustScore !== '';
          const state = (hasEnabled || hasScore)
            ? await setSkillSharing({
              enabled: hasEnabled ? (data.enabled === true || /^(true|on|yes|1|enable)/i.test(String(data.enabled))) : undefined,
              minTrustScore: hasScore ? Number(data.minTrustScore) : undefined
            })
            : await getSkillSharing();
          const envNote = state.source === 'env' ? ' (SKILLS_P2P_SHARE in .env sets this and overrides the switch)' : '';
          return {
            success: true,
            enabled: state.enabled,
            minTrustScore: state.minTrustScore,
            result: state.enabled
              ? `Skill sharing is ON${envNote}: I teach my skills to trusted agents on the Skynet network and use theirs. Trusted = the genesis agent, peers you mark trusted, or a trust score of ${state.minTrustScore}+; skills from anyone else wait for your approval.`
              : `Skill sharing is OFF${envNote}: I neither teach nor learn skills over the Skynet network.`
          };
        }
        case 'setTrellisTeaching': {
          const { setTrellisTeaching, getTrellisTeaching } = await import('../../services/skills/skillTeaching.js');
          const has = data.enabled !== undefined && data.enabled !== null && data.enabled !== '';
          const state = has
            ? await setTrellisTeaching(data.enabled === true || /^(true|on|yes|1|enable)/i.test(String(data.enabled)))
            : await getTrellisTeaching();
          const envNote = state.source === 'env' ? ' (SKILLS_TRELLIS_TEACH in .env sets this and overrides the switch)' : '';
          return {
            success: true,
            enabled: state.enabled,
            offers: state.offers,
            result: state.enabled
              ? `Trellis skill teaching is ON${envNote}: agents that ask for a procedure get my skill as a SKILL.md${state.offers ? ', and an agent describing a problem a skill solves is offered it (sent only if it says yes)' : ''}.`
              : `Trellis skill teaching is OFF${envNote}: I don't send my skills to other agents in Trellis channels.`
          };
        }
        case 'update': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const skill = await service.update(data.name, { description: data.description, body: data.body }, { actor: 'operator', reason: data.reason || 'edited by the operator' });
          return { success: true, result: `Updated skill "${skill.name}". Undo with "roll back the ${skill.name} skill".` };
        }
        case 'history': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const h = await service.history(data.name, { limit: Number(data.limit) || 10 });
          if (!h.length) return { success: true, history: [], result: `No recorded changes to "${data.name}".` };
          return { success: true, history: h.map(e => ({ at: e.at, actor: e.actor, action: e.action, reason: e.reason })), result: h.map(e => `• ${e.at.slice(0, 16).replace('T', ' ')} ${e.action} by ${e.actor}${e.reason ? ` — ${e.reason}` : ''}`).join('\n') };
        }
        case 'rollback': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const skill = await service.rollback(data.name, { actor: 'operator' });
          return { success: true, result: `Rolled back the last change to "${skill.name}".` };
        }
        case 'archive': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          await service.archive(data.name, { actor: 'operator', reason: data.reason || '' });
          return { success: true, result: `Archived "${data.name}". Restore it any time with "restore the ${data.name} skill".` };
        }
        case 'restore': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const skill = await service.restore(data.name, { actor: 'operator' });
          return { success: true, result: `Restored "${skill.name}".` };
        }
        case 'pin': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const on = data.pinned === undefined ? true : (data.pinned === true || /^(true|on|yes|1)/i.test(String(data.pinned)));
          await service.setPinned(data.name, on);
          return { success: true, pinned: on, result: on ? `Pinned "${data.name}": housekeeping will leave it alone.` : `Unpinned "${data.name}".` };
        }
        case 'shareAudit': {
          const [{ getShareAudit }, { default: SkillSharing }] = await Promise.all([
            import('../../services/skills/shareAudit.js'), import('../../services/p2p/skillSharing.js')]);
          const audit = getShareAudit();
          if (data.name) {
            const skill = await service.get(data.name);
            if (!skill) return { success: false, error: `No skill named "${data.name}"` };
            const r = await audit.audit(SkillSharing.payload(skill));
            const state = r.released ? 'released by the operator' : r.verdict === 'clear' ? 'cleared for sharing' : r.verdict === 'blocked' ? 'kept private' : 'not decided yet (the review failed; it retries)';
            return { success: true, audit: r, result: `"${skill.name}": ${state}${r.findings?.length ? ` — ${r.findings.join('; ')}` : ''}` };
          }
          const all = await audit.list();
          if (!all.length) return { success: true, audits: [], result: 'No skill has been audited for sharing yet.' };
          const line = r => `${r.released ? '🔓' : r.verdict === 'clear' ? '✅' : r.verdict === 'blocked' ? '🔒' : '⏳'} ${r.name}${r.findings?.length && !r.released ? ` — ${r.findings.join('; ')}` : ''}`;
          return { success: true, audits: all, result: `Skill sharing audit (latest per skill):\n${all.map(line).join('\n')}` };
        }
        case 'releaseForSharing': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const [{ getShareAudit }, { default: SkillSharing }] = await Promise.all([
            import('../../services/skills/shareAudit.js'), import('../../services/p2p/skillSharing.js')]);
          const skill = await service.get(data.name);
          if (!skill) return { success: false, error: `No skill named "${data.name}"` };
          await getShareAudit().release(SkillSharing.payload(skill), 'operator');
          return { success: true, result: `Released "${skill.name}" for sharing, for its current content. An edit will be audited again.` };
        }
        case 'installFromUrl': {
          const { installSkillFromUrl } = await import('../../services/skills/skillInstall.js');
          const r = await installSkillFromUrl(data.url || data.source || data.link);
          if (!r.installed) return { success: false, error: r.reason };
          const { sendSkillNotice } = await import('../../services/skills/skillNotice.js');
          const { skill, ...info } = r;
          await sendSkillNotice(this.agent, skill || { name: r.name, description: r.description, meta: { status: r.status } }, `Installed a skill from a link (${r.source})`);
          const state = r.status === 'active'
            ? `It is active (auto-approve is on); Telegram has a Reject button if you don't want it.`
            : `It is PENDING: I won't use it until you approve it (Telegram, "approve skill ${r.name}", or the Skills page).`;
          return { success: true, ...info, result: `Installed "${r.name}" from ${r.source}${r.updated ? ' (updated)' : ''}. ${state} What it does: ${r.description}` };
        }
        case 'evaluate': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const { evaluateTriggers } = await import('../../services/skills/skillQuality.js');
          const r = await evaluateTriggers({ service, providerManager: this.agent?.providerManager, name: data.name });
          const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
          const misses = r.cases.filter(c => !c.pass).slice(0, 6).map(c => `• ${c.expected ? 'missed' : 'wrongly used for'}: "${c.query.slice(0, 120)}"`).join('\n');
          return { success: true, ...r, result: `${r.name}: used for ${pct(r.recall)} of the requests it should handle, and wrongly for ${r.falseTriggers} near-miss request(s); ${pct(r.passRate)} correct overall.${misses ? `\n${misses}` : ''}` };
        }
        case 'curate': {
          if (!this.agent?.curator) return { success: false, error: 'The curator is not running on this agent' };
          const r = await this.agent.curator.run();
          const parts = [];
          if (r.stale.length) parts.push(`marked stale: ${r.stale.join(', ')}`);
          if (r.archived.length) parts.push(`archived: ${r.archived.join(', ')}`);
          if (r.merged.length) parts.push(`merged: ${r.merged.map(m => `${m.archived} → ${m.kept}`).join(', ')}`);
          if (r.profile?.changed) parts.push(`profile tidied (${r.profile.from} → ${r.profile.chars} characters)`);
          return { success: true, report: r, result: parts.length ? `Housekeeping done — ${parts.join('; ')}.` : 'Housekeeping done — nothing needed changing.' };
        }
        case 'profile': {
          const profile = this.agent?.userProfile || (await import('../../services/skills/userProfile.js')).getUserProfile();
          if (data.set !== undefined) {
            const text = await profile.set(String(data.set), 'operator');
            return { success: true, profile: text, result: 'Profile replaced; it is used from the next message on.' };
          }
          if (data.add) {
            const added = await profile.add([].concat(data.add), 'operator');
            await profile.refreshSnapshot();
            return { success: true, added, result: added.length ? `Added to your profile: ${added.join('; ')}` : 'That is already in your profile (or looked like a secret, which is never stored there).' };
          }
          const text = await profile.text();
          return { success: true, profile: text, result: text ? `What I keep about you (part of every prompt):\n${text}` : 'Your profile is empty so far.' };
        }
        case 'reject': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const removed = await service.reject(data.name);
          return removed ? { success: true, result: `Rejected and removed the pending skill "${data.name}".` } : { success: false, error: `No pending skill named "${data.name}"` };
        }
        case 'delete': {
          this.validateParams(data, { name: { required: true, type: 'string' } });
          const removed = await service.remove(data.name);
          return removed ? { success: true, result: `Deleted skill "${data.name}".` } : { success: false, error: `No skill named "${data.name}"` };
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`skills ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async extractParameters(input, action) {
    const prompts = {
      create: `The user wants to save a procedure as a reusable skill. From their message, produce JSON only:
{"name": "short-kebab-case-name", "description": "one sentence: what it does and when to use it", "body": "the procedure as markdown numbered steps, in the user's words"}`,
      update: `The user wants to change an existing skill. Produce JSON only: {"name": "kebab-case skill name", "body": "the full new procedure as markdown steps if they gave one, else omit", "description": "new one-line description if they gave one, else omit", "reason": "what they want changed"}`,
      installFromUrl: `Extract the link or owner/repo/path of the skill to install. JSON only: {"url": "..."}`,
      profile: `The user is talking about the profile the agent keeps about them. JSON only: {"add": "the fact or preference to remember, in one short line"} if they want something remembered; {} if they only want to see it.`,
      pin: `Extract the skill and whether to pin it. JSON only: {"name": "kebab-case-name", "pinned": true|false}`
    };
    const prompt = `${prompts[action] || 'Extract the skill name the user refers to, as JSON only: {"name": "kebab-case-name"}'}
Message: "${input}"`;
    const response = await this.agent.providerManager.generateAux(prompt, { maxTokens: ['create', 'update'].includes(action) ? 1200 : 120, temperature: 0.2 });
    return safeJsonParse(response.content, {}) || {};
  }

  getUIConfig() {
    return {
      menuItem: { id: 'skills', title: 'Skills', icon: 'fas fa-brain', order: 63, section: 'main' },
      hasUI: true
    };
  }

  getUIContent() {
    return `
      <style>
        .sk-card { background: var(--card-bg); border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
        .sk-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; padding: .6rem 0; border-bottom: 1px solid rgba(128,128,128,.18); }
        .sk-row:last-child { border-bottom: none; }
        .sk-name { font-weight: 600; font-family: var(--font-mono, monospace); }
        .sk-desc { opacity: .8; font-size: .9rem; margin-top: .2rem; }
        .sk-badge { display: inline-block; font-size: .7rem; padding: .05rem .45rem; border-radius: 999px; margin-left: .4rem; border: 1px solid rgba(128,128,128,.4); opacity: .85; vertical-align: middle; }
        .sk-badge.pending { border-color: #f59e0b; color: #f59e0b; }
        .sk-actions { display: flex; gap: .4rem; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
        .sk-actions .btn { padding: .25rem .6rem; font-size: .8rem; }
        .sk-body { white-space: pre-wrap; font-size: .85rem; background: rgba(128,128,128,.08); padding: .75rem; border-radius: 6px; margin-top: .5rem; max-height: 420px; overflow: auto; }
        .sk-settings { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: .75rem 1.5rem; }
        .sk-settings label { display: flex; gap: .5rem; align-items: center; }
        .sk-muted { opacity: .65; font-size: .85rem; }
        .sk-form input, .sk-form textarea { width: 100%; margin-bottom: .5rem; padding: .5rem; border-radius: 6px; }
        .sk-filter { width: 100%; padding: .45rem; border-radius: 6px; margin-bottom: .5rem; }
        .sk-err { color: #ef4444; }
      </style>

      <div class="plugin-header"><h2>Skills</h2></div>
      <div class="plugin-content">
        <div class="sk-card">
          <h3>Settings</h3>
          <div class="sk-settings">
            <label><input type="checkbox" id="sk-auto"> Use skills other agents teach at once (auto-approve)</label>
            <label><input type="checkbox" id="sk-share"> Share skills with trusted agents on the P2P network</label>
            <label>Trust score to use a peer's skills without approval <input type="number" id="sk-score" min="0" max="100" style="width:5rem"></label>
            <label><input type="checkbox" id="sk-teach"> Teach skills to agents that ask in Trellis channels</label>
          </div>
          <div id="sk-settings-note" class="sk-muted"></div>
        </div>

        <div class="sk-card" id="sk-pending-card" style="display:none">
          <h3>Waiting for approval <button class="btn" id="sk-approve-all" style="float:right">Approve all</button></h3>
          <div id="sk-pending"></div>
        </div>

        <div class="sk-card">
          <h3>Skills <span id="sk-count" class="sk-muted"></span> <button class="btn" id="sk-curate" style="float:right">Run housekeeping now</button></h3>
          <div class="sk-muted">Learned skills unused for 30 days go stale and are archived after 90 (restorable). Pin a skill to keep it as it is.</div>
          <input class="sk-filter" id="sk-filter" placeholder="Filter by name or description">
          <div id="sk-list" class="sk-muted">Loading…</div>
        </div>

        <div class="sk-card">
          <h3>About you</h3>
          <div class="sk-muted">What the agent keeps about you. It is part of every prompt, so keep it short. The agent adds to it when you mention a lasting preference; you can edit it freely.</div>
          <textarea id="sk-profile" rows="6" style="width:100%;margin-top:.5rem;padding:.5rem;border-radius:6px" placeholder="- Prefers short answers"></textarea>
          <button class="btn" id="sk-profile-save">Save</button> <span id="sk-profile-note" class="sk-muted"></span>
        </div>

        <div class="sk-card sk-form">
          <h3>Install a skill from a link</h3>
          <input id="sk-install-url" placeholder="GitHub link to a SKILL.md or its folder, owner/repo/path, or a raw https link">
          <button class="btn" id="sk-install">Install</button>
          <span id="sk-install-result" class="sk-muted" style="margin-left:.5rem"></span>
          <div class="sk-muted">It waits for your approval before it is used.</div>
        </div>

        <div class="sk-card" id="sk-archived-card" style="display:none">
          <h3>Archived</h3>
          <div id="sk-archived"></div>
        </div>

        <div class="sk-card">
          <h3>Trellis Skills basket</h3>
          <div class="sk-muted">Skills shared in the Trellis document. Live ones are installed here automatically every 10 minutes.
            <button class="btn" id="sk-sync" style="margin-left:.5rem">Sync now</button></div>
          <div id="sk-basket" class="sk-muted" style="margin-top:.5rem">Loading…</div>
        </div>

        <div class="sk-card sk-form">
          <h3>New skill</h3>
          <input id="sk-new-name" placeholder="name (lowercase-with-hyphens)">
          <input id="sk-new-desc" placeholder="One sentence: what it does and when to use it">
          <textarea id="sk-new-body" rows="8" placeholder="The procedure, as markdown steps"></textarea>
          <button class="btn" id="sk-create">Save skill</button>
          <span id="sk-create-result" class="sk-muted" style="margin-left:.5rem"></span>
        </div>
      </div>

      <script>
        (function() {
          const token = localStorage.getItem('lanagent_token');
          const call = async (plugin, action, data = {}) => {
            try {
              const r = await fetch('/api/plugin', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ plugin, action, ...data })
              });
              const j = await r.json();
              return (j && j.success === undefined && j.result && typeof j.result === 'object') ? j.result : j;
            } catch (e) { return { success: false, error: e.message }; }
          };
          const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
          const $ = id => document.getElementById(id);
          const OWN = ['manual', 'auto', 'bundled', 'lanagent', 'hermes-agent'];
          let all = [];

          function badge(s) {
            const b = [];
            if (s.status === 'pending') b.push('<span class="sk-badge pending">pending</span>');
            const src = s.bundled ? 'built-in' : s.source === 'auto' ? 'learned' : s.source === 'peer' ? 'from ' + (s.taughtBy || 'an agent')
              : s.source === 'trellis' ? 'Trellis basket' : s.source === 'manual' ? 'yours' : s.source;
            if (src) b.push('<span class="sk-badge">' + esc(src) + '</span>');
            if (s.pinned) b.push('<span class="sk-badge">📌 pinned</span>');
            if (s.state === 'stale') b.push('<span class="sk-badge pending">stale</span>');
            if (s.uses !== undefined) b.push('<span class="sk-badge">used ' + esc(s.uses) + '×' + (s.lastUsed ? ', last ' + esc(String(s.lastUsed).slice(0, 10)) : '') + '</span>');
            if (s.warnings && s.warnings.length) b.push('<span class="sk-badge pending" title="' + esc(s.warnings.join(' ')) + '">' + s.warnings.length + ' tip' + (s.warnings.length > 1 ? 's' : '') + '</span>');
            return b.join('');
          }

          function row(s, pending) {
            const btns = pending
              ? '<button class="btn" data-act="approve" data-n="' + esc(s.name) + '">Approve</button><button class="btn" data-act="reject" data-n="' + esc(s.name) + '">Reject</button>'
              : '<button class="btn" data-act="view" data-n="' + esc(s.name) + '">View</button>' +
                '<button class="btn" data-act="history" data-n="' + esc(s.name) + '">History</button>' +
                '<button class="btn" data-act="evaluate" data-n="' + esc(s.name) + '" title="Check it is used for the right requests">Test triggering</button>' +
                '<button class="btn" data-act="pin" data-n="' + esc(s.name) + '" data-pinned="' + (s.pinned ? '1' : '') + '">' + (s.pinned ? 'Unpin' : 'Pin') + '</button>' +
                (s.bundled ? '' : '<button class="btn" data-act="archive" data-n="' + esc(s.name) + '">Archive</button>') +
                (OWN.includes(s.source) || s.bundled ? '<button class="btn" data-act="publish" data-n="' + esc(s.name) + '" title="Share in the Trellis Skills basket">Publish</button>' : '') +
                (s.bundled ? '' : '<button class="btn" data-act="delete" data-n="' + esc(s.name) + '">Delete</button>');
            return '<div class="sk-row" data-row="' + esc(s.name) + '"><div style="min-width:0;flex:1"><span class="sk-name">' + esc(s.name) + '</span>' + badge(s) +
              '<div class="sk-desc">' + esc(s.description) + '</div><div class="sk-view"></div></div><div class="sk-actions">' + btns + '</div></div>';
          }

          function render() {
            const q = $('sk-filter').value.trim().toLowerCase();
            const active = all.filter(s => s.status !== 'pending' && (!q || (s.name + ' ' + s.description).toLowerCase().includes(q)));
            const pending = all.filter(s => s.status === 'pending');
            $('sk-count').textContent = '(' + all.length + ')';
            $('sk-list').innerHTML = active.length ? active.map(s => row(s, false)).join('') : 'No skills match.';
            $('sk-pending-card').style.display = pending.length ? '' : 'none';
            $('sk-pending').innerHTML = pending.map(s => row(s, true)).join('');
          }

          async function loadSkills() {
            const r = await call('skills', 'list', { includeArchived: true });
            const arch = (r && r.archived) || [];
            $('sk-archived-card').style.display = arch.length ? '' : 'none';
            $('sk-archived').innerHTML = arch.map(a => '<div class="sk-row"><div><span class="sk-name">' + esc(a.name) + '</span><div class="sk-desc">archived ' + esc(String(a.archivedAt).slice(0, 10)) + '</div></div><div class="sk-actions"><button class="btn" data-act="restore" data-n="' + esc(a.folder) + '">Restore</button></div></div>').join('');
            if (!r || !r.success) { $('sk-list').innerHTML = '<span class="sk-err">' + esc((r && r.error) || 'Could not load skills') + '</span>'; return; }
            all = (r.skills || []).sort((a, b) => a.name.localeCompare(b.name));
            render();
          }

          async function loadSettings() {
            const [a, sh, t] = await Promise.all([call('skills', 'setAutoApprove'), call('skills', 'setSharing'), call('skills', 'setTrellisTeaching')]);
            if (a && a.success) $('sk-auto').checked = !!a.enabled;
            if (sh && sh.success) { $('sk-share').checked = !!sh.enabled; $('sk-score').value = sh.minTrustScore ?? 50; }
            if (t && t.success) $('sk-teach').checked = !!t.enabled;
            const env = [a, sh, t].map(x => x && x.result).filter(x => /\.env/.test(x || ''));
            $('sk-settings-note').textContent = env.length ? env.join(' ') : '';
          }

          async function loadBasket() {
            const r = await call('trellis-notes', 'listBasketSkills');
            const box = $('sk-basket');
            if (!r || !r.success) { box.innerHTML = '<span class="sk-muted">' + esc((r && r.error) || 'Trellis is not configured') + '</span>'; return; }
            if (!r.skills.length) { box.textContent = 'The basket is empty.'; return; }
            box.innerHTML = r.skills.map(s => '<div class="sk-row"><div><span class="sk-name">' + esc(s.name) + '</span><span class="sk-badge' + (s.status === 'live' ? '' : ' pending') + '">' + esc(s.status) + '</span>' +
              (s.writer ? '<span class="sk-badge">by ' + esc(s.writer) + '</span>' : '') + '<div class="sk-desc">' + esc(s.description) + '</div></div>' +
              '<div class="sk-muted">card ' + esc(s.card) + '</div></div>').join('');
          }

          const toast = (msg, ok) => (window.app && window.app.showNotification) ? window.app.showNotification(msg, ok ? 'success' : 'error') : alert(msg);
          const settle = (r, okMsg) => { toast(r && r.success ? (typeof r.result === 'string' ? r.result : okMsg) : ((r && r.error) || 'Failed'), r && r.success); return r && r.success; };

          document.querySelector('.plugin-content').addEventListener('click', async (e) => {
            const b = e.target.closest('button[data-act]');
            if (!b) return;
            const n = b.dataset.n, act = b.dataset.act;
            if (act === 'view') {
              const box = b.closest('.sk-row').querySelector('.sk-view');
              if (box.innerHTML) { box.innerHTML = ''; return; }
              const r = await call('skills', 'view', { name: n });
              box.innerHTML = r && r.success ? '<div class="sk-body">' + esc(r.skill.body) + '</div>' : '<span class="sk-err">' + esc(r && r.error) + '</span>';
              return;
            }
            if (act === 'history') {
              const box = b.closest('.sk-row').querySelector('.sk-view');
              if (box.innerHTML) { box.innerHTML = ''; return; }
              const r = await call('skills', 'history', { name: n });
              const h = (r && r.history) || [];
              box.innerHTML = h.length
                ? '<div class="sk-body">' + h.map(e => esc(String(e.at).slice(0, 16).replace('T', ' ')) + '  ' + esc(e.action) + ' by ' + esc(e.actor) + (e.reason ? ' — ' + esc(e.reason) : '')).join('\\n') + '</div>' +
                  (h[0].action === 'update' ? '<button class="btn" data-act="rollback" data-n="' + esc(n) + '">Undo the last change</button>' : '')
                : '<div class="sk-muted">No recorded changes.</div>';
              return;
            }
            if (act === 'evaluate') {
              const box = b.closest('.sk-row').querySelector('.sk-view');
              box.innerHTML = '<div class="sk-muted">Writing test requests and running them through the matcher…</div>';
              b.disabled = true;
              const r = await call('skills', 'evaluate', { name: n });
              b.disabled = false;
              if (!r || !r.success) { box.innerHTML = '<span class="sk-err">' + esc((r && r.error) || 'Failed') + '</span>'; return; }
              const tips = (all.find(x => x.name === n) || {}).warnings || [];
              box.innerHTML = '<div class="sk-body">' + esc(r.result) + (tips.length ? '\\n\\nTips:\\n' + tips.map(t => '• ' + esc(t)).join('\\n') : '') + '</div>';
              return;
            }
            if (act === 'pin') {
              b.disabled = true;
              const r = await call('skills', 'pin', { name: n, pinned: !b.dataset.pinned });
              b.disabled = false;
              if (settle(r, 'Saved')) loadSkills();
              return;
            }
            if (act === 'archive' && !confirm('Archive "' + n + '"? It stops being used; you can restore it later.')) return;
            if (act === 'rollback' && !confirm('Undo the last change to "' + n + '"?')) return;
            if (act === 'delete' && !confirm('Delete the skill "' + n + '"?')) return;
            if (act === 'reject' && !confirm('Reject and remove "' + n + '"?')) return;
            if (act === 'publish' && !confirm('Publish "' + n + '" to the Trellis Skills basket? Other agents in the document can then use it.')) return;
            b.disabled = true;
            const r = act === 'publish' ? await call('trellis-notes', 'publishSkill', { skill: n }) : await call('skills', act, { name: n });
            b.disabled = false;
            if (settle(r, 'Done')) { await loadSkills(); if (act === 'publish') loadBasket(); }
          });

          $('sk-approve-all').addEventListener('click', async () => { if (settle(await call('skills', 'approveAll'), 'Approved')) loadSkills(); });
          $('sk-filter').addEventListener('input', render);
          $('sk-auto').addEventListener('change', async e => { settle(await call('skills', 'setAutoApprove', { enabled: e.target.checked }), 'Saved'); loadSkills(); loadSettings(); });
          $('sk-share').addEventListener('change', async e => { settle(await call('skills', 'setSharing', { enabled: e.target.checked }), 'Saved'); loadSettings(); });
          $('sk-score').addEventListener('change', async e => { settle(await call('skills', 'setSharing', { minTrustScore: Number(e.target.value) }), 'Saved'); loadSettings(); });
          $('sk-teach').addEventListener('change', async e => { settle(await call('skills', 'setTrellisTeaching', { enabled: e.target.checked }), 'Saved'); loadSettings(); });
          $('sk-sync').addEventListener('click', async e => {
            e.target.disabled = true;
            const r = await call('trellis-notes', 'syncBasketSkills');
            e.target.disabled = false;
            if (settle(r, 'Synced')) { loadSkills(); loadBasket(); }
          });
          $('sk-create').addEventListener('click', async () => {
            const out = $('sk-create-result');
            const r = await call('skills', 'create', { name: $('sk-new-name').value, description: $('sk-new-desc').value, body: $('sk-new-body').value });
            out.innerHTML = r && r.success ? esc(r.result) : '<span class="sk-err">' + esc((r && r.error) || 'Failed') + '</span>';
            if (r && r.success) { $('sk-new-name').value = $('sk-new-desc').value = $('sk-new-body').value = ''; loadSkills(); }
          });

          $('sk-curate').addEventListener('click', async e => {
            e.target.disabled = true;
            const r = await call('skills', 'curate');
            e.target.disabled = false;
            if (settle(r, 'Done')) loadSkills();
          });
          $('sk-install').addEventListener('click', async () => {
            const out = $('sk-install-result');
            out.textContent = 'Installing…';
            const r = await call('skills', 'installFromUrl', { url: $('sk-install-url').value.trim() });
            out.innerHTML = r && r.success ? esc(r.result) : '<span class="sk-err">' + esc((r && r.error) || 'Failed') + '</span>';
            if (r && r.success) { $('sk-install-url').value = ''; loadSkills(); }
          });
          async function loadProfile() {
            const r = await call('skills', 'profile');
            if (r && r.success) $('sk-profile').value = r.profile || '';
          }
          $('sk-profile-save').addEventListener('click', async () => {
            const r = await call('skills', 'profile', { set: $('sk-profile').value });
            $('sk-profile-note').textContent = r && r.success ? 'Saved — used from the next message on.' : ((r && r.error) || 'Failed');
          });

          loadSettings(); loadSkills(); loadBasket(); loadProfile();
        })();
      </script>
    `;
  }

  async getAICapabilities() {
    return { enabled: true, examples: this.commands.flatMap(cmd => cmd.examples || []) };
  }
}
