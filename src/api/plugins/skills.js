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

    if (params.needsParameterExtraction && this.agent.providerManager && action !== 'list') {
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
            result: `${skills.length} skill(s):\n` + skills.map(s => `• ${s.name}${s.source === 'auto' ? ' (learned)' : ''}: ${s.description}`).join('\n')
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
