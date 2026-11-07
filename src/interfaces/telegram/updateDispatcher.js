import { logger } from '../../utils/logger.js';

/**
 * Telegraf's long-polling loop fetches the next batch of updates only after EVERY handler in
 * the current batch has returned (`await Promise.all(updates.map(handleUpdate))`). One slow
 * request — a 30s answer, a 10-minute video download — therefore froze the whole bot: a Stop
 * tap, a menu button or a second message sat unread until it finished.
 *
 * This makes the loop non-blocking while keeping what ordering is for:
 *  - messages in the same chat sent within a few seconds of each other run in order (a 2FA code typed
 *    right after a request must not overtake it); after that a new message runs at once;
 *  - everything else (button taps, stop-generation, inline queries) runs at once, so it can
 *    act on a request that is still in progress.
 * Webhook delivery is left alone: there Telegram waits on the response anyway.
 */

const HOLD_MS = Number(process.env.TELEGRAM_CHAT_ORDER_HOLD_MS) || 5000;
const SEQUENTIAL = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'business_message'];

/** The chat whose queue an update joins, or null when it should run immediately. */
export function queueKeyOf(update) {
  for (const type of SEQUENTIAL) {
    const chatId = update?.[type]?.chat?.id;
    if (chatId !== undefined && chatId !== null) return String(chatId);
  }
  return null;
}

export function installConcurrentUpdates(bot, { holdMs = HOLD_MS } = {}) {
  if (!bot || bot.__concurrentUpdates) return bot;
  const original = bot.handleUpdate.bind(bot);
  const queues = new Map(); // chat id → tail promise of that chat's queue

  const run = (update) => original(update).catch(err => {
    logger.error(`[telegram] update ${update?.update_id} failed: ${err?.message || err}`);
  });

  bot.handleUpdate = (update, webhookResponse) => {
    if (webhookResponse) return original(update, webhookResponse);
    const key = queueKeyOf(update);
    if (!key) {
      run(update);
      return Promise.resolve();
    }
    // Order is kept only for messages sent close together. A message sent while an earlier one has been running for
    // more than a few seconds runs at once: on 2026-11-07 a 4-minute request held the owner's next messages unread and
    // the chat looked locked.
    const prev = queues.get(key);
    if (prev && Date.now() - prev.startedAt > holdMs) {
      logger.info(`[telegram] chat busy for ${Math.round((Date.now() - prev.startedAt) / 1000)}s; running the new message now`);
      run(update);
      return Promise.resolve();
    }
    const entry = { startedAt: Date.now() };
    entry.tail = (prev?.tail || Promise.resolve()).then(() => { entry.startedAt = Date.now(); return run(update); });
    queues.set(key, entry);
    entry.tail.finally(() => { if (queues.get(key) === entry) queues.delete(key); });
    return Promise.resolve();
  };
  bot.__concurrentUpdates = true;
  bot.__updateQueues = queues;
  return bot;
}
