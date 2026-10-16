import { logger } from '../../utils/logger.js';

/**
 * The agent's answers as Telegram rich messages (Bot API 10.1+, sendRichMessage /
 * editMessageText rich_message). Rich Markdown is GitHub-flavored Markdown — what the model
 * writes — so headings, tables, task lists, code blocks and <details> render natively, up to
 * 32768 characters in one message instead of 4096-character chunks of legacy Markdown that
 * 400 on an unpaired _ or *.
 *
 * Only for model output. Bot-written notices use legacy Telegram Markdown, where *x* is
 * bold; in Rich Markdown *x* is italic, so those stay on the old path.
 *
 * Probed live 2026-10-16: unclosed ** and ``` are tolerated, "$580 to $612" stays text, but
 * a bare < starts HTML and words vanish ("a<b and c>d" lost text, "<your-api-key>" was
 * dropped). toRichMarkdown() escapes < outside code; &lt; renders as <.
 *
 * TELEGRAM_RICH_MESSAGES=off turns it off. A method-level refusal (an older Bot API server)
 * turns it off for the process; any other failure falls back for that one message.
 */

export const RICH_TEXT_LIMIT = 32768;

let disabledReason = null;

export function richEnabled() {
  if (disabledReason) return false;
  return String(process.env.TELEGRAM_RICH_MESSAGES || 'on').toLowerCase() !== 'off';
}

/** Test hook. */
export function resetRichState() { disabledReason = null; }

/** Escape `<` everywhere except inside fenced code blocks and inline code spans. */
export function toRichMarkdown(text) {
  const src = String(text ?? '');
  const out = [];
  const lines = src.split('\n');
  let fence = null; // the opening fence (``` or ~~~, possibly longer) while inside a block
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    if (m) { fence = m[1]; out.push(line); continue; }
    out.push(escapeOutsideCodeSpans(line));
  }
  return out.join('\n');
}

function escapeOutsideCodeSpans(line) {
  let result = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let n = 0;
      while (line[i + n] === '`') n++;
      const ticks = '`'.repeat(n);
      const close = line.indexOf(ticks, i + n);
      if (close !== -1) {
        result += line.slice(i, close + n);
        i = close + n;
        continue;
      }
      result += ticks;
      i += n;
      continue;
    }
    result += line[i] === '<' ? '&lt;' : line[i];
    i++;
  }
  return result;
}

function fits(text) {
  const s = String(text ?? '');
  return s.trim().length > 0 && s.length <= RICH_TEXT_LIMIT;
}

function noteFailure(err, what) {
  const msg = String(err?.description || err?.message || err);
  // An API server without rich messages answers 404 "Not Found" for the method, or names
  // the unknown parameter; nothing rich will work, so stop trying until restart.
  if (/not found|method.*(unknown|not supported)|rich_message.*(unknown|unsupported)|unknown.*rich/i.test(msg)
      && !/message to edit not found|chat not found/i.test(msg)) {
    disabledReason = msg;
    logger.warn(`[telegram] rich messages unavailable, using legacy Markdown from now on: ${msg}`);
  } else {
    logger.warn(`[telegram] rich ${what} failed, falling back for this message: ${msg}`);
  }
}

/**
 * Send model output as a rich message.
 * @returns {Promise<object|null>} the sent Message, or null when the caller must fall back
 */
export async function sendRich(telegram, chatId, text, { threadId, replyMarkup, disableNotification } = {}) {
  if (!richEnabled() || !fits(text)) return null;
  try {
    return await telegram.callApi('sendRichMessage', {
      chat_id: chatId,
      rich_message: { markdown: toRichMarkdown(text) },
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(disableNotification ? { disable_notification: true } : {})
    });
  } catch (err) {
    noteFailure(err, 'send');
    return null;
  }
}

/**
 * Turn an existing message (e.g. the streamed one) into the rich final reply.
 * @returns {Promise<boolean>} true when Telegram accepted the edit
 */
export async function editToRich(telegram, chatId, messageId, text, { replyMarkup } = {}) {
  if (!richEnabled() || !fits(text) || !messageId) return false;
  try {
    await telegram.callApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      rich_message: { markdown: toRichMarkdown(text) },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    return true;
  } catch (err) {
    if (/not modified/i.test(String(err?.message))) return true;
    noteFailure(err, 'edit');
    return false;
  }
}
