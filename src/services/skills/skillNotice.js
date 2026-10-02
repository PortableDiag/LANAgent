/**
 * Tell the operator on Telegram that a skill arrived from outside: taught by another agent in
 * Trellis, or installed from a link. Active (auto-approve on) → the notice says so and offers
 * Reject + "turn off auto-approve"; pending → Approve / Reject / Approve all / Always
 * auto-approve. The buttons are handled in telegramDashboard.js. Best effort, never throws:
 * without Telegram, "approve skill <name>" and the Skills page still work.
 *
 * Several skills that arrive together (one Trellis message carrying several SKILL.md files)
 * go out as ONE message via sendSkillNotices: per-skill buttons for each, the bulk buttons once.
 */
import { logger } from '../../utils/logger.js';
import { getSkillsService } from './skillsService.js';

const MAX_SKILLS_PER_NOTICE = 10;

/**
 * @param {object} agent agent with an optional Telegram interface
 * @param {Array<{skill: object, origin: string}>} notices skills to announce
 * @param {{service?: object, maxSkills?: number}} [options]
 * @returns {Promise<boolean>} whether a notification was sent
 */
export async function sendSkillNotices(agent, notices, { service = getSkillsService(), maxSkills = MAX_SKILLS_PER_NOTICE } = {}) {
  try {
    const tg = agent?.interfaces?.get?.('telegram');
    if (!tg?.sendNotification || !Array.isArray(notices)) return false;
    const valid = notices.filter(n => n?.skill?.name);
    if (!valid.length) return false;
    const limit = Number.isInteger(maxSkills) && maxSkills > 0 ? maxSkills : MAX_SKILLS_PER_NOTICE;
    const entries = valid.slice(0, limit);

    // Skills that arrived together share one origin line instead of repeating it per skill.
    const oneOrigin = entries.every(e => e.origin === entries[0].origin);
    const keyboard = [];
    const parts = oneOrigin && entries.length > 1 ? [`🧠 ${entries[0].origin}:`] : [];
    let anyActive = false, anyPending = false;
    for (const { skill, origin } of entries) {
      const active = skill.meta?.status === 'active';
      if (active) anyActive = true; else anyPending = true;
      // Telegram caps callback_data at 64 bytes; a longer name gets no per-skill button.
      if (`skill_ok:${skill.name}`.length <= 64) {
        keyboard.push(active
          ? [{ text: '🗑 Reject', callback_data: `skill_no:${skill.name}` }]
          : [{ text: '✅ Approve', callback_data: `skill_ok:${skill.name}` }, { text: '🗑 Reject', callback_data: `skill_no:${skill.name}` }]);
      }
      const tail = active
        ? "Auto-approved (auto-approve is on): I'll use it from now on."
        : "It is pending: I won't use it until you approve it.";
      const head = oneOrigin && entries.length > 1 ? '' : `🧠 ${origin}:\n\n`;
      parts.push(`${head}${skill.name} — ${skill.description}\n\n${tail}`);
    }
    if (valid.length > entries.length) {
      parts.push(`…and ${valid.length - entries.length} more; see the Skills page.`);
    }
    if (anyActive) keyboard.push([{ text: '⏸ Turn off auto-approve', callback_data: 'skill_auto_off' }]);
    if (anyPending) {
      const waiting = (await service.pending()).length;
      keyboard.push(
        [{ text: `✅ Approve all pending (${waiting})`, callback_data: 'skill_ok_all' }],
        [{ text: '⚙️ Always auto-approve', callback_data: 'skill_auto_on' }]
      );
    }
    await tg.sendNotification(parts.join('\n\n'),
      { parse_mode: undefined, reply_markup: { inline_keyboard: keyboard.filter(r => r.length) } });
    return true;
  } catch (err) {
    logger.debug(`[skills] could not send the skill notice on Telegram: ${err.message}`);
    return false;
  }
}

export async function sendSkillNotice(agent, skill, origin, { service = getSkillsService() } = {}) {
  return sendSkillNotices(agent, [{ skill, origin }], { service });
}
