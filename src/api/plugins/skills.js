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
        description: 'Turn automatic approval of skills other agents teach on or off (off by default); turning it on also approves any already pending',
        usage: 'setAutoApprove({ enabled: true })',
        examples: ['turn on auto approve skills', 'auto approve skills from other agents', 'turn off skill auto approval', 'stop auto approving skills', 'is skill auto approve on']
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

    if (params.needsParameterExtraction && this.agent.providerManager && action !== 'list' && action !== 'approveAll' && action !== 'setAutoApprove') {
      Object.assign(data, await this.extractParameters(params.originalInput || params.input, action));
    }

    try {
      switch (action) {
        case 'list': {
          const skills = await service.list();
          if (!skills.length) return { success: true, count: 0, result: `No skills yet. Add one with "save this as a skill…" or drop a SKILL.md into ${SKILLS_DIR}.` };
          return {
            success: true,
            count: skills.length,
            skills,
            result: `${skills.length} skill(s):\n` + skills.map(s => `• ${s.name}${s.status === 'pending' ? ` (PENDING — taught by ${s.taughtBy || 'another agent'}; "approve skill ${s.name}" to use it)` : s.source === 'auto' ? ' (learned)' : ''}: ${s.description}`).join('\n')
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
    const prompt = action === 'create'
      ? `The user wants to save a procedure as a reusable skill. From their message, produce JSON only:
{"name": "short-kebab-case-name", "description": "one sentence: what it does and when to use it", "body": "the procedure as markdown numbered steps, in the user's words"}
Message: "${input}"`
      : `Extract the skill name the user refers to, as JSON only: {"name": "kebab-case-name"}
Message: "${input}"`;
    const response = await this.agent.providerManager.generateAux(prompt, { maxTokens: action === 'create' ? 800 : 60, temperature: 0.2 });
    return safeJsonParse(response.content, {}) || {};
  }

  async getAICapabilities() {
    return { enabled: true, examples: this.commands.flatMap(cmd => cmd.examples || []) };
  }
}
