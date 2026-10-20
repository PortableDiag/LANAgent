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
  constructor() {
    this.settled = false;
    this.emojis = [];
    this.attemptedEmojis = [];
    this.failedPhases = [];
  }

  ok() {
    this.settled = true;
  }

  fail() {
    this.settled = true;
  }

  /**
   * Resolve with the outcome shape used by active reaction acknowledgements.
   *
   * @returns {Promise<{settled: boolean, attemptedEmojis: string[], emojis: string[], failedPhases: string[]}>}
   */
  flush() {
    return Promise.resolve(this._outcome());
  }

  _outcome() {
    return {
      settled: this.settled,
      attemptedEmojis: [...this.attemptedEmojis],
      emojis: [...this.emojis],
      failedPhases: [...this.failedPhases],
    };
  }
}

export class ReactionAck {
  /**
   * Create a reaction acknowledgement for a specific message.
   *
   * @param {object} telegram - Grammy Telegram instance (must have setMessageReaction)
   * @param {number|string} chatId - Telegram chat identifier
   * @param {number} messageId - Telegram message identifier
   *
   * No retry on a refused reaction: reactions are best effort (see the header), and a
   * backoff on 👀 would hold the chained final reaction back by seconds.
   */
  constructor(telegram, chatId, messageId) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.messageId = messageId;
    this.settled = false;
    this.emojis = []; // reactions actually applied, for tests and logs
    this.attemptedEmojis = [];
    this.failedPhases = [];
    this.chain = Promise.resolve();
  }

  /**
   * Static factory to create a ReactionAck directly from identifiers, bypassing ctx.
   * Useful for reacting to bot's own messages or messages from other users.
   *
   * @param {object} telegram - Grammy Telegram instance
   * @param {number|string} chatId - Telegram chat identifier
   * @param {number} messageId - Telegram message identifier
   * @returns {ReactionAck} A started reaction acknowledgement instance
   */
  static forMessage(telegram, chatId, messageId) {
    return new ReactionAck(telegram, chatId, messageId).start();
  }

  _set(emoji, phase) {
    const operation = this.chain.then(async () => {
      this.attemptedEmojis.push(emoji);

      try {
        await this.telegram.setMessageReaction(this.chatId, this.messageId, [{ type: 'emoji', emoji }]);
        this.emojis.push(emoji);
      } catch (err) {
        this.failedPhases.push(phase);
        try {
          logger.debug(`[telegram] reaction ${emoji} on message ${this.messageId} failed: ${err?.description || err?.message || err}`);
        } catch {
          // Logging must not turn a best-effort reaction into a rejected lifecycle promise.
        }
      }
    });

    this.chain = operation;
    return operation;
  }

  start() {
    this._set(REACTION_WORKING, 'working');
    return this;
  }

  /** The reply was sent. First settlement wins; later calls are ignored. */
  ok() {
    this._settle(REACTION_DONE, 'done');
  }

  /** Processing failed or produced nothing useful. */
  fail() {
    this._settle(REACTION_FAILED, 'failed');
  }

  _settle(emoji, phase) {
    if (this.settled) return;
    this.settled = true;
    this._set(emoji, phase);
  }

  /**
   * Wait for all reactions queued so far and return their best-effort outcome.
   * Reaction failures are absorbed and reported in failedPhases.
   *
   * @returns {Promise<{settled: boolean, attemptedEmojis: string[], emojis: string[], failedPhases: string[]}>}
   */
  flush() {
    return this.chain.then(() => ({
      settled: this.settled,
      attemptedEmojis: [...this.attemptedEmojis],
      emojis: [...this.emojis],
      failedPhases: [...this.failedPhases],
    }));
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
    return new ReactionAck(ctx.telegram, ctx.chat.id, ctx.message.message_id).start();
  } catch (err) {
    logger.debug(`[telegram] reaction ack unavailable: ${err?.message || err}`);
    return new NoopAck();
  }
}
