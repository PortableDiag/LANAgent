import { logger } from '../../utils/logger.js';

/**
 * Private-chat topics (Bot API: `has_topics_enabled` in getMe, needs @BotFather). Each topic is
 * its own conversation: the text handler passes its message_thread_id as the conversation's
 * threadId, so follow-ups in one topic never see another's (memoryManager.conversationKey).
 *
 * This file titles a new topic from its first message, the way AI chat apps do — but only a
 * topic that still has a placeholder name. A name the operator typed is never changed.
 */

const GENERIC = /^(new (chat|topic|conversation|thread)|topic|chat|untitled|thread)(\s*#?\d+)?$/i;
const MAX_TITLE = 64;

export function isPlaceholderName(name) {
  return GENERIC.test(String(name ?? '').trim());
}

/** A title from the message itself, when no model answers: its first few words. */
export function fallbackTitle(text) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  const t = words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words;
  return t || 'Conversation';
}

export function cleanTitle(raw, text) {
  const t = String(raw ?? '').split('\n')[0].replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.\s]+$/g, '').replace(/^title:\s*/i, '').trim();
  return (t && t.length <= MAX_TITLE ? t : fallbackTitle(text)).slice(0, MAX_TITLE);
}

export class TopicTitler {
  constructor({ telegram, generate = null }) {
    this.telegram = telegram;
    this.generate = generate;
    this.names = new Map();   // `${chat}:${thread}` → the name it was created with
  }

  /** A forum_topic_created service message: remember the topic's name. */
  noteCreated(msg) {
    const name = msg?.forum_topic_created?.name;
    if (!msg?.message_thread_id || name === undefined) return;
    this.names.set(`${msg.chat.id}:${msg.message_thread_id}`, name);
  }

  /** After the first message in a placeholder-named topic: give it a real name, once. */
  async maybeTitle(msg, text) {
    const key = `${msg?.chat?.id}:${msg?.message_thread_id}`;
    const name = this.names.get(key);
    if (name === undefined || name === null || !isPlaceholderName(name)) return null;
    this.names.set(key, null);   // once, whatever happens below
    let title = fallbackTitle(text);
    if (this.generate) {
      try {
        const r = await this.generate(`Give a title of at most five words for a conversation that starts with this message. Reply with the title only.\n\n${String(text).slice(0, 800)}`, { maxTokens: 24, temperature: 0.2 });
        title = cleanTitle(r?.content, text);
      } catch (err) {
        logger.debug(`[topics] title model failed: ${err.message}`);
      }
    }
    try {
      await this.telegram.callApi('editForumTopic', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, name: title });
      logger.info(`[topics] titled topic ${msg.message_thread_id}: "${title}"`);
      return title;
    } catch (err) {
      logger.debug(`[topics] editForumTopic failed: ${err.description || err.message}`);
      return null;
    }
  }
}
