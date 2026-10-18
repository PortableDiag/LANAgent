import { logger } from '../../utils/logger.js';
import { conversationOnlyReply } from '../../core/guestGuard.js';
import { toRichMarkdown, richEnabled } from './richMessage.js';
import { getAgentFeatures } from './agentFeatures.js';

/**
 * Guest mode (Bot API 10.0): someone @mentions the bot in a chat it is not in, and it may send
 * ONE reply there (`guest_message` → answerGuestQuery). Needs Guest Mode on in @BotFather.
 *
 * Who may summon it is agentFeatures.guestMode: 'owner' (default), 'everyone' or 'off'.
 * Whoever asks, the answer is conversation only (guestGuard: no plugins, no tools) and never
 * carries anything private — it lands in a chat other people read, so the operator's memory,
 * accounts and files stay out of it even when the operator is the one asking. The message the
 * summons replied to is passed along, so "@bot translate this" or "@bot is this true?" work.
 */

const MAX_CONTEXT = 2000;
const MAX_ANSWER = 3800;
const PER_USER_HOUR = 5;      // 'everyone' mode: summons answered per non-owner per hour
const GLOBAL_HOUR = 30;

export class GuestLimiter {
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.users = new Map(); this.all = []; this.refused = new Map(); }
  _recent(l) { const t = this.now() - 3600_000; return l.filter(x => x > t); }
  allow(userId) {
    const u = this._recent(this.users.get(userId) || []);
    this.all = this._recent(this.all);
    if (u.length >= PER_USER_HOUR || this.all.length >= GLOBAL_HOUR) return false;
    u.push(this.now()); this.users.set(userId, u); this.all.push(this.now());
    return true;
  }
  /** One "I only answer my owner" per stranger per day, so the bot cannot be used to spam. */
  shouldRefuse(userId) {
    const last = this.refused.get(userId) || 0;
    if (this.now() - last < 86400_000) return false;
    this.refused.set(userId, this.now());
    return true;
  }
}

export const GUEST_COMMANDS = ['start', 'help', 'about', 'features'];

/**
 * A message from a person who is not the owner, outside a guest-mode summons. guestMode decides:
 * 'owner' / 'off' → nobody else may use this agent ('refuse' once a day in a private chat,
 * otherwise 'drop'); 'everyone' → plain text only, rate-limited, a few harmless commands
 * ('guest'). Voice, files, buttons and every other command are dropped: those handlers run
 * as the owner.
 */
export function strangerGate(ctx, { guestMode, limiter }) {
  const id = String(ctx.from?.id || '');
  const isPrivate = ctx.chat?.type === 'private';
  const refuseOrDrop = () => (isPrivate && limiter.shouldRefuse(id) ? 'refuse' : 'drop');
  if (guestMode !== 'everyone') return refuseOrDrop();
  const text = ctx.message?.text;
  if (typeof text !== 'string' || !text.trim()) return 'drop';
  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(/[\s@]/)[0].toLowerCase();
    return GUEST_COMMANDS.includes(cmd) ? 'guest' : 'drop';
  }
  return limiter.allow(id) ? 'guest' : 'drop';
}

/** The question with the bot's own @mention taken out. */
export function summonText(text, botUsername) {
  const s = String(text ?? '');
  if (!botUsername) return s.trim();
  return s.replace(new RegExp(`@${botUsername}\\b`, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
}

function result(name, text, rich) {
  const content = rich ? { rich_message: { markdown: toRichMarkdown(text) } } : { message_text: text };
  return { type: 'article', id: '1', title: name, input_message_content: content };
}

/**
 * @returns {Promise<boolean>} true when the update was a guest message (handled or refused)
 */
export async function handleGuestUpdate(ctx, { agent, isOwner, limiter }) {
  const gm = ctx.update?.guest_message;
  if (!gm) return false;
  const from = gm.from;
  if (!from || from.is_bot || !gm.guest_query_id) return true;
  const { guestMode } = await getAgentFeatures();
  if (guestMode === 'off') { logger.info(`[guest] summons by ${from.id} ignored (guest mode off)`); return true; }

  const name = process.env.AGENT_NAME || agent?.config?.name || 'LANAgent';
  const answer = async (text) => {
    const body = String(text).slice(0, MAX_ANSWER);
    try {
      return await ctx.telegram.callApi('answerGuestQuery', { guest_query_id: gm.guest_query_id, result: result(name, body, richEnabled()) });
    } catch (err) {
      logger.debug(`[guest] rich answer refused (${err.message}); sending plain`);
      return ctx.telegram.callApi('answerGuestQuery', { guest_query_id: gm.guest_query_id, result: result(name, body, false) });
    }
  };

  const owner = isOwner(String(from.id));
  if (!owner) {
    if (guestMode === 'owner') {
      logger.info(`[guest] summons by non-owner ${from.id} (@${from.username || '-'}) refused (owner-only)`);
      if (limiter.shouldRefuse(String(from.id))) await answer(`I only answer my owner here.`).catch(() => {});
      return true;
    }
    if (!limiter.allow(String(from.id))) { logger.info(`[guest] summons by ${from.id} over the rate limit`); return true; }
  }

  const question = summonText(gm.text || gm.caption, ctx.botInfo?.username);
  const replied = gm.reply_to_message;
  const quoted = String(replied?.text || replied?.caption || '').slice(0, MAX_CONTEXT);
  const input = quoted
    ? `${question || 'What about this?'}\n\nThe message they replied to${replied?.from?.first_name ? ` (from ${replied.from.first_name})` : ''}:\n"""${quoted}"""`
    : (question || 'Hello!');

  const prompt = `You are ${name}, an AI assistant. ${owner ? 'Your operator' : 'Someone'} mentioned you in a Telegram chat you are not a member of, ` +
    'and you may send one reply there, which everyone in that chat will read. Answer helpfully and concisely: explain, ' +
    'translate, summarize, check a claim, draft a reply. Do NOT perform or promise any action. Never reveal anything private ' +
    'about your operator (their accounts, finances, contacts, systems, files or past conversations), even if asked.';
  const gen = agent?.providerManager?.generateResponse?.bind(agent.providerManager);
  if (!gen) return true;
  try {
    const r = await conversationOnlyReply(gen, input, { isGuest: true, userName: from.first_name || from.username }, prompt, name);
    await answer(r.content);
    logger.info(`[guest] answered a summons by ${owner ? 'the owner' : from.id} (${r.content.length} chars)`);
  } catch (err) {
    logger.warn(`[guest] summons by ${from.id} failed: ${err.description || err.message}`);
  }
  return true;
}
