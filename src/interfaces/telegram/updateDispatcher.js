import { logger } from '../../utils/logger.js';

/**
 * Telegraf's long-polling loop fetches the next batch of updates only after EVERY handler in
 * the current batch has returned (`await Promise.all(updates.map(handleUpdate))`). One slow
 * request — a 30s answer, a 10-minute video download — therefore froze the whole bot: a Stop
 * tap, a menu button or a second message sat unread until it finished.
 *
 * This makes the loop non-blocking while keeping what ordering is for:
 *  - messages in the same chat still run one after another, in order (a 2FA code typed
 *    while a request is running must not overtake it);
 *  - everything else (button taps, stop-generation, inline queries) runs at once, so it can
 *    act on a request that is still in progress.
 * Webhook delivery is left alone: there Telegram waits on the response anyway.
 */

const SEQUENTIAL = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'business_message'];

/** The chat whose queue an update joins, or null when it should run immediately. */
export function queueKeyOf(update) {
  for (const type of SEQUENTIAL) {
    const chatId = update?.[type]?.chat?.id;
    if (chatId !== undefined && chatId !== null) return String(chatId);
  }
  return null;
}

export function installConcurrentUpdates(bot) {
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
    const tail = (queues.get(key) || Promise.resolve()).then(() => run(update));
    queues.set(key, tail);
    tail.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
    return Promise.resolve();
  };
  bot.__concurrentUpdates = true;
  bot.__updateQueues = queues;
  return bot;
}
