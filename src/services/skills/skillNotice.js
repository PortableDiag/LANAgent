/**
 * Tell the operator on Telegram that a skill arrived from outside: taught by another agent in
 * Trellis, or installed from a link. Active (auto-approve on) → the notice says so and offers
 * Reject + "turn off auto-approve"; pending → Approve / Reject / Approve all / Always
 * auto-approve. The buttons are handled in telegramDashboard.js. Best effort, never throws:
 * without Telegram, "approve skill <name>" and the Skills page still work.
 */
import { logger } from '../../utils/logger.js';
import { getSkillsService } from './skillsService.js';

export async function sendSkillNotice(agent, skill, origin, { service = getSkillsService() } = {}) {
  try {
    const tg = agent?.interfaces?.get?.('telegram');
    if (!tg?.sendNotification || !skill?.name) return false;
    const active = skill.meta?.status === 'active';
    const fits = `skill_ok:${skill.name}`.length <= 64;
    let keyboard, tail;
    if (active) {
      keyboard = [
        fits ? [{ text: '🗑 Reject', callback_data: `skill_no:${skill.name}` }] : [],
        [{ text: '⏸ Turn off auto-approve', callback_data: 'skill_auto_off' }]
      ];
      tail = "Auto-approved (auto-approve is on): I'll use it from now on.";
    } else {
      const waiting = (await service.pending()).length;
      keyboard = [
        fits ? [{ text: '✅ Approve', callback_data: `skill_ok:${skill.name}` }, { text: '🗑 Reject', callback_data: `skill_no:${skill.name}` }] : [],
        [{ text: `✅ Approve all pending (${waiting})`, callback_data: 'skill_ok_all' }],
        [{ text: '⚙️ Always auto-approve', callback_data: 'skill_auto_on' }]
      ];
      tail = "It is pending: I won't use it until you approve it.";
    }
    await tg.sendNotification(`🧠 ${origin}:\n\n${skill.name} — ${skill.description}\n\n${tail}`,
      { parse_mode: undefined, reply_markup: { inline_keyboard: keyboard.filter(r => r.length) } });
    return true;
  } catch (err) {
    logger.debug(`[skills] could not send the skill notice on Telegram: ${err.message}`);
    return false;
  }
}
