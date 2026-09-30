import { logger } from '../../utils/logger.js';

/**
 * Emoji reactions on the operator's message as a read receipt: 👀 while the agent works on
 * it, then 👍 when the reply went out or 🤷 when processing failed.
 *
 * Best effort by design. Every call is fire-and-forget: a refused reaction (old message,
 * chat without reactions, rate limit, blocked bot) is logged at debug and never delays or
 * breaks the reply. The final reaction is chained after 👀 so it cannot land first and be
 * overwritten by it.
 *
 * Only emojis in Telegram's fixed reaction list are accepted by setMessageReaction
 * (ReactionTypeEmoji in @grammyjs/types); all three below are in it.
 * Off with TELEGRAM_REACTIONS=false.
 */

export const REACTION_WORKING = '👀';
export const REACTION_DONE = '👍';
export const REACTION_FAILED = '🤷';

export function reactionsEnabled(env = process.env) {
  return String(env.TELEGRAM_REACTIONS ?? 'true').trim().toLowerCase() !== 'false';
}

/** A message the operator typed or spoke — not a button tap, not the bot's own message. */
export function shouldReact(ctx) {
  if (!ctx?.chat?.id || ctx.callbackQuery) return false;
  const m = ctx.message;
  if (!m?.message_id) return false;
  if (m.from?.is_bot) return false;
  return Boolean(m.text || m.voice);
}

class NoopAck {
  constructor() { this.settled = false; this.emojis = []; }
  ok() { this.settled = true; }
  fail() { this.settled = true; }
}

export class ReactionAck {
  constructor(ctx) {
    this.telegram = ctx.telegram;
    this.chatId = ctx.chat.id;
    this.messageId = ctx.message.message_id;
    this.settled = false;
    this.emojis = []; // reactions actually applied, for tests and logs
    this.chain = Promise.resolve();
  }

  _set(emoji) {
    this.chain = this.chain.then(async () => {
      try {
        await this.telegram.setMessageReaction(this.chatId, this.messageId, [{ type: 'emoji', emoji }]);
        this.emojis.push(emoji);
      } catch (err) {
        logger.debug(`[telegram] reaction ${emoji} on message ${this.messageId} failed: ${err?.description || err?.message || err}`);
      }
    });
    return this.chain;
  }

  start() { this._set(REACTION_WORKING); return this; }

  /** The reply was sent. First settlement wins; later calls are ignored. */
  ok() { this._settle(REACTION_DONE); }

  /** Processing failed or produced nothing useful. */
  fail() { this._settle(REACTION_FAILED); }

  _settle(emoji) {
    if (this.settled) return;
    this.settled = true;
    this._set(emoji);
  }
}

/**
 * Start acknowledging ctx.message. Returns an object with ok()/fail(); a no-op one when
 * reactions are off or the update is not a message to acknowledge. Never throws.
 */
export function startReactionAck(ctx, { env = process.env } = {}) {
  try {
    if (!reactionsEnabled(env) || !shouldReact(ctx) || typeof ctx.telegram?.setMessageReaction !== 'function') {
      return new NoopAck();
    }
    return new ReactionAck(ctx).start();
  } catch (err) {
    logger.debug(`[telegram] reaction ack unavailable: ${err?.message || err}`);
    return new NoopAck();
  }
}
