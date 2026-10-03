import { BasePlugin } from '../core/basePlugin.js';
import { scheduleFollowUp, FOLLOW_UP_DELAYS_MIN } from '../../services/followUps.js';

/**
 * Schedule a check-back the agent has promised ("I'll poll again and report"). Without it the
 * promise had nothing behind it (2026-10-02). See services/followUps.js.
 */
export default class FollowUpPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'followup';
    this.version = '1.0.0';
    this.description = 'Schedule a follow-up check: come back later to see whether something you are waiting for (a reaction, a job, a status) has happened, and report it';
    this.commands = [
      {
        command: 'schedule',
        description: `Come back later and check: the task is re-run by you at ${FOLLOW_UP_DELAYS_MIN.join(', ')} minutes until it is done. Use this whenever you tell someone you will check again or report back`,
        usage: 'schedule({ task: "Check whether reapption task ac32c752 got a reaction and report it to the operator", inMinutes: 5 })',
        examples: ['check back on this later', 'remind yourself to poll the task', 'follow up when the job finishes', 'report back once it is ready']
      }
    ];
  }

  async execute(params = {}) {
    const { action, task, inMinutes, _context = {} } = params;
    if (action !== 'schedule') return { success: false, error: `Unknown action: ${action}. Use schedule.` };
    if (!String(task || '').trim()) return { success: false, error: 'schedule needs the task to check' };
    const when = await scheduleFollowUp(this.agent, { task, context: _context, inMinutes, reason: 'scheduled by the agent' });
    if (!when) return { success: false, error: 'The scheduler is not running, so no follow-up could be scheduled' };
    return { success: true, scheduledFor: when.toISOString(), result: `Follow-up scheduled for ${when.toISOString()}` };
  }
}
