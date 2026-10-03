import { logger } from '../utils/logger.js';

/**
 * Follow-ups the agent promised ("I'll poll again and report"). Before this, such a promise was
 * a sentence with nothing behind it: on 2026-10-02 the operator reacted to a test link within
 * two minutes and the agent never noticed, because no step ever came back to look.
 *
 * A follow-up is an Agenda job (it survives restarts) that re-runs the task through the
 * reasoning agent with the same channel context. That run checks with its tools; if what it was
 * waiting for happened, it reports and the follow-up ends; if not, it answers NOT_YET silently
 * and the next attempt is scheduled, at most FOLLOW_UP_DELAYS_MIN.length times.
 */
export const FOLLOW_UP_JOB = 'agent-follow-up';
export const FOLLOW_UP_DELAYS_MIN = [5, 15, 45];
export const NOT_YET = 'NOT_YET';

/** Whether a reply promises to come back later. */
export function promisesFollowUp(text) {
  const t = String(text || '');
  return /\b(i'?ll|i will|we'?ll|will)\s+(poll|check\s+(back|again|later|on it)|follow\s+up|report\s+back|keep\s+(checking|polling|an eye)|let you know (when|once)|update (you|this) (when|once))/i.test(t)
    || /\bonce (it|the [a-z]+|you)\b[^.\n]{0,60}\b(i'?ll|i will)\s+(report|post|let|check|update)/i.test(t);
}

function scheduler(agent) {
  return agent?.scheduler?.agenda || null;
}

/** Schedule attempt `attempt` (1-based) of a follow-up. Returns the run time, or null. */
export async function scheduleFollowUp(agent, { task, context = {}, attempt = 1, inMinutes = null, reason = '' } = {}) {
  const agenda = scheduler(agent);
  if (!agenda || !String(task || '').trim()) return null;
  if (attempt > FOLLOW_UP_DELAYS_MIN.length) return null;
  const minutes = Math.max(1, Math.min(24 * 60, Number(inMinutes) || FOLLOW_UP_DELAYS_MIN[attempt - 1]));
  const trellis = context.trellis ? {
    document: context.trellis.document ?? null,
    card: context.trellis.card ?? null,
    peer: context.trellis.peer ?? null
  } : null;
  const when = new Date(Date.now() + minutes * 60000);
  await agenda.schedule(when, FOLLOW_UP_JOB, {
    task: String(task).slice(0, 4000),
    trellis,
    userId: context.userId || null,
    interface: context.interface || null,
    attempt,
    reason: String(reason || '').slice(0, 200)
  });
  logger.info(`[follow-up] scheduled attempt ${attempt} in ${minutes} min${trellis?.card ? ` (Trellis card ${trellis.card})` : ''}: ${String(task).slice(0, 100)}`);
  return when;
}

/** The job body: check once; report if done, else schedule the next attempt. */
export async function runFollowUp(agent, data = {}) {
  const { task, trellis, userId, attempt = 1 } = data;
  const where = trellis?.card ? ` Report in the Trellis channel on card ${trellis.card} with trellis-notes.replyChannel.` : '';
  const prompt = `Follow-up you promised earlier (check ${attempt} of ${FOLLOW_UP_DELAYS_MIN.length}). The original request:\n"""\n${task}\n"""\n` +
    `Check NOW with your tools whether what you were waiting for has happened (a status, a reaction, a job finishing).` +
    ` If it has, do what you said you would and report the result with ids and status codes.${where}` +
    ` If it has not happened yet, do not post anything and give exactly ${NOT_YET} as the final answer.`;
  const context = {
    userId: userId || (trellis?.peer ? `trellis-peer:${trellis.peer}` : (process.env.TELEGRAM_USER_ID || 'follow-up')),
    interface: trellis ? 'trellis' : (data.interface || 'follow-up'),
    followUp: true,                      // its own "not yet" reschedules; no safety-net copy
    ...(trellis ? { trellis: { ...trellis, recent: '' } } : {})
  };
  let answer = '';
  try {
    const rendered = await agent._runReasoning(prompt, context);
    answer = String(rendered?.content ?? rendered?.text ?? '');
  } catch (err) {
    logger.warn(`[follow-up] attempt ${attempt} failed: ${err.message}`);
  }
  if (!answer || answer.includes(NOT_YET)) {
    const next = await scheduleFollowUp(agent, { task, context: { ...context, trellis }, attempt: attempt + 1 });
    logger.info(next ? `[follow-up] not yet; next check at ${next.toISOString()}` : '[follow-up] not yet after the last check; giving up');
    return { done: false, next };
  }
  logger.info(`[follow-up] done on attempt ${attempt}`);
  return { done: true, answer };
}
