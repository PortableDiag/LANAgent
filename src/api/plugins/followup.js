import { BasePlugin } from '../core/basePlugin.js';
import { scheduleFollowUp, FOLLOW_UP_DELAYS_MIN } from '../../services/followUps.js';

const MAX_BATCH = 10;

/**
 * Schedule a check-back the agent has promised ("I'll poll again and report"). Without it the
 * promise had nothing behind it (2026-10-02). See services/followUps.js.
 */
export default class FollowUpPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'followup';
    this.version = '1.1.0';
    this.description = 'Schedule a follow-up check: come back later to see whether something you are waiting for (a reaction, a job, a status) has happened, and report it';
    this.commands = [
      {
        command: 'schedule',
        description: `Come back later and check: the task is re-run by you at ${FOLLOW_UP_DELAYS_MIN.join(', ')} minutes until it is done. Use this whenever you tell someone you will check again or report back`,
        usage: 'schedule({ task: "Check whether reapption task ac32c752 got a reaction and report it to the operator", inMinutes: 5 })',
        examples: ['check back on this later', 'remind yourself to poll the task', 'follow up when the job finishes', 'report back once it is ready']
      },
      {
        command: 'batch',
        description: 'Schedule multiple follow-up tasks at once, reducing round trips when several check-backs are needed',
        usage: 'batch({ tasks: [{ task: "Check deployment status", inMinutes: 5 }, { task: "Verify backup completion", inMinutes: 30 }] })',
        examples: ['schedule several reminders at once', 'set multiple follow-ups in one call']
      }
    ];
  }

  async execute(params = {}) {
    const { action, task, inMinutes, _context = {}, tasks } = params;

    if (action === 'schedule') {
      if (!String(task || '').trim()) return { success: false, error: 'schedule needs the task to check' };
      const when = await scheduleFollowUp(this.agent, { task, context: _context, inMinutes, reason: 'scheduled by the agent' });
      if (!when) return { success: false, error: 'The scheduler is not running, so no follow-up could be scheduled' };
      return { success: true, scheduledFor: when.toISOString(), result: `Follow-up scheduled for ${when.toISOString()}` };
    }

    if (action === 'batch') {
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return { success: false, error: 'batch requires a non-empty tasks array' };
      }
      if (tasks.length > MAX_BATCH) {
        return { success: false, error: `batch takes at most ${MAX_BATCH} tasks; got ${tasks.length}` };
      }

      const results = [];
      for (const item of tasks) {
        try {
          if (!item || !String(item.task || '').trim()) {
            results.push({ task: item?.task, success: false, error: 'Each task item must have a non-empty task string' });
            continue;
          }
          const when = await scheduleFollowUp(this.agent, {
            task: item.task,
            context: _context,
            inMinutes: item.inMinutes,
            reason: 'batch scheduled by agent'
          });
          if (!when) {
            results.push({ task: item.task, success: false, error: 'Scheduler not running' });
          } else {
            results.push({ task: item.task, success: true, scheduledFor: when.toISOString() });
          }
        } catch (err) {
          results.push({ task: item?.task, success: false, error: err.message });
        }
      }

      // success:false when nothing was scheduled, so the ReAct safety net (which treats a
      // successful followup action as "scheduled") still schedules the promised check-back.
      const ok = results.filter(r => r.success).length;
      return {
        success: ok > 0,
        scheduled: results,
        ...(ok === 0 ? { error: 'No follow-up could be scheduled' } : {}),
        result: `${ok} of ${results.length} follow-ups scheduled`
      };
    }

    return { success: false, error: `Unknown action: ${action}. Use schedule or batch.` };
  }
}
