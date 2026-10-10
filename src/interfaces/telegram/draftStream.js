import { logger } from '../../utils/logger.js';

/**
 * A reply that streams into the chat as it is written (Bot API sendMessageDraft).
 *
 *  - start()   shows Telegram's own "Thinking…" placeholder (a draft with empty text) instead
 *              of sending a "🤔 Thinking..." message and deleting it again, which buzzed the
 *              phone and flickered a message in and out.
 *  - status()  replaces the placeholder with progress ("🔧 web search") until text arrives.
 *  - chunk()   streams the answer, with a Stop button (can_stop). Pressing it aborts the
 *              generation through `signal`; the partial answer is kept (keep_on_stop) and the
 *              caller sends it as the real message.
 *  - finish()  cleans up. A draft is ephemeral: the caller's final sendMessage replaces it.
 *
 * A draft lives about 30 seconds, so the last text is re-sent every REFRESH_MS while a slow
 * step runs. Drafts are private-chat only; if the first one is refused, this falls back to
 * the old status message (sent, edited, deleted) so nothing is lost on a client or chat that
 * cannot show drafts.
 */

export const DRAFT_THROTTLE_MS = 350;
export const DRAFT_REFRESH_MS = 20000;
export const TELEGRAM_TEXT_LIMIT = 4096;

const active = new Map(); // `${chatId}:${draftId}` → DraftStream
const keyOf = (chatId, draftId) => `${chatId}:${draftId}`;

/**
 * Route a `stopped_message_generation` update to the stream it belongs to.
 * @returns {boolean} true when the update was a stop (handled or not)
 */
export function handleStopUpdate(update) {
  const s = update?.stopped_message_generation;
  if (!s) return false;
  const stream = active.get(keyOf(s.chat?.id, s.draft_id));
  if (stream) stream.stopByUser();
  else logger.info(`[telegram] stop pressed for draft ${s.draft_id}, which already finished`);
  return true;
}

export function clip(text, limit = TELEGRAM_TEXT_LIMIT) {
  const s = String(text ?? '');
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/**
 * Ten-cell text progress bar, e.g. "███░░░░░░░ indexing 30%". Plain text: no Markdown
 * characters are added (the label is passed through as given).
 * @returns {string} '' when percent is not a finite number
 */
export function progressBar(percent, label) {
  const n = Number(percent);
  if (percent === null || percent === '' || !Number.isFinite(n)) return '';
  const p = Math.max(0, Math.min(100, Math.round(n)));
  const filled = Math.round(p / 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${label ? `${label} ` : ''}${p}%`;
}

export class DraftStream {
  /**
   * @param {object} telegram Telegraf `ctx.telegram` (callApi, sendMessage, editMessageText, deleteMessage)
   * @param {number} chatId
   * @param {object} [opts]
   */
  constructor(telegram, chatId, { threadId, throttleMs = DRAFT_THROTTLE_MS, refreshMs = DRAFT_REFRESH_MS, fallbackText = '🤔 Thinking...' } = {}) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.threadId = threadId;
    this.throttleMs = throttleMs;
    this.refreshMs = refreshMs;
    this.fallbackText = fallbackText;
    this.draftId = Math.floor(Math.random() * 2147483646) + 1;
    this.controller = new AbortController();
    this.mode = 'idle';          // idle → draft | message → done
    this.streaming = false;      // answer text has started
    this.stopped = false;        // the user pressed Stop
    this.text = '';              // last text shown
    this.lastSentAt = 0;
    this.inFlight = false;
    this.pending = null;         // newest text not yet sent (throttled)
    this.statusMessage = null;   // fallback mode only
    this.refreshTimer = null;
    this.trailing = null;
    this.draftsSent = 0;
  }

  get signal() { return this.controller.signal; }

  async start() {
    active.set(keyOf(this.chatId, this.draftId), this);
    if (await this._draft('')) {
      this.mode = 'draft';
      this._armRefresh();
      return this;
    }
    this.mode = 'message';
    try {
      this.statusMessage = await this.telegram.sendMessage(this.chatId, this.fallbackText,
        this.threadId ? { message_thread_id: this.threadId } : undefined);
      this.text = this.fallbackText;
    } catch (err) {
      logger.warn(`[telegram] could not send status message: ${err.message}`);
    }
    return this;
  }

  /** Progress text shown until the answer starts streaming. */
  async status(text) {
    if (this.streaming || this.stopped || !text || text === this.text) return;
    if (this.mode === 'draft') {
      await this._draft(clip(text));
    } else if (this.mode === 'message' && this.statusMessage) {
      try {
        await this.telegram.editMessageText(this.chatId, this.statusMessage.message_id, undefined, clip(text));
        this.text = text;
      } catch (err) {
        logger.debug(`[telegram] could not update status message: ${err.message}`);
      }
    }
  }

  /**
   * Show a progress bar as the status (draft or fallback status message), until the
   * answer starts streaming. Non-numeric percents are ignored.
   * @param {number} percent 0–100
   * @param {string} [label] optional label before the percentage
   */
  async progress(percent, label) {
    if (this.stopped) return;
    const bar = progressBar(percent, label);
    if (bar) await this.status(bar);
  }

  /** Stream callback for providerManager.generateStreamingResponse (delta, fullText). */
  async chunk(_delta, fullText) {
    if (this.stopped || this.mode !== 'draft') { this.streaming = true; return; }
    this.streaming = true;
    this.pending = fullText;
    const wait = this.throttleMs - (Date.now() - this.lastSentAt);
    if (this.inFlight || wait > 0) {
      // Trailing flush, so a pause in the model's output still shows the newest text.
      if (!this.trailing && !this.inFlight) {
        this.trailing = setTimeout(() => { this.trailing = null; this._flushPending().catch(() => {}); }, Math.max(wait, 0));
        this.trailing.unref?.();
      }
      return;
    }
    await this._flushPending();
  }

  async _flushPending() {
    while (this.pending !== null && !this.stopped && this.mode === 'draft') {
      const text = this.pending;
      this.pending = null;
      await this._draft(clip(text), { can_stop: true, keep_on_stop: true });
    }
  }

  /** Show the complete answer before the caller sends it as a message. */
  async complete(fullText) {
    if (this.mode !== 'draft' || this.stopped || !this.streaming || !fullText) return;
    this.pending = null;
    if (this.trailing) { clearTimeout(this.trailing); this.trailing = null; }
    await this._draft(clip(fullText));
  }

  /** Drafts are replaced by the caller's own message. */
  async deliver() { return false; }

  stopByUser() {
    if (this.stopped) return;
    this.stopped = true;
    logger.info(`[telegram] user stopped generation of draft ${this.draftId}`);
    this.controller.abort(new Error('Stopped by user'));
  }

  async finish() {
    active.delete(keyOf(this.chatId, this.draftId));
    if (this.trailing) clearTimeout(this.trailing);
    this.trailing = null;
    this.pending = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.mode === 'message' && this.statusMessage) {
      try { await this.telegram.deleteMessage(this.chatId, this.statusMessage.message_id); } catch { /* gone */ }
    }
    this.mode = 'done';
  }

  _armRefresh() {
    if (!this.refreshMs) return;
    this.refreshTimer = setInterval(() => {
      if (this.mode !== 'draft' || this.stopped || this.inFlight) return;
      if (Date.now() - this.lastSentAt < this.refreshMs) return;
      this._draft(clip(this.text), this.streaming ? { can_stop: true, keep_on_stop: true } : {}).catch(() => {});
    }, Math.min(this.refreshMs, 5000));
    this.refreshTimer.unref?.();
  }

  /** @returns {Promise<boolean>} whether Telegram accepted the draft */
  async _draft(text, extra = {}) {
    this.inFlight = true;
    try {
      await this.telegram.callApi('sendMessageDraft', {
        chat_id: this.chatId,
        draft_id: this.draftId,
        text,
        ...(this.threadId ? { message_thread_id: this.threadId } : {}),
        ...extra
      });
      this.text = text;
      this.lastSentAt = Date.now();
      this.draftsSent++;
      return true;
    } catch (err) {
      // First refusal: fall back to a status message. Later: stop drafting for this reply
      // (the final message still arrives) and say why, once.
      if (this.mode === 'draft') {
        logger.warn(`[telegram] sendMessageDraft failed, streaming off for this reply: ${err.message}`);
        this.mode = 'message';
      } else {
        logger.warn(`[telegram] sendMessageDraft unavailable (${err.message}) — using a status message`);
      }
      return false;
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * Streaming by editing a real message (the default; Hermes's default too). Native drafts
 * (DraftStream) left a large blank area under the reply in the operator's Telegram app until
 * the chat was reopened (2026-09-28), so drafts are opt-in via TELEGRAM_STREAM_TRANSPORT=draft.
 *
 *  - Nothing is sent while the agent thinks; the chat action shows "typing…".
 *  - The first answer text is SENT (so it notifies like any reply) with an inline ⏹ Stop
 *    button; later text EDITS that message, throttled to Telegram's edit rate.
 *  - deliver(finalText) turns it into the finished reply: formatted, Stop button gone. The
 *    caller then skips its own send. A reply too long for one message is removed and the
 *    caller sends it split, as before.
 */
export const EDIT_THROTTLE_MS = 1200;
const CURSOR = ' ▍';
const byId = new Map(); // stream id → EditStream (for the ⏹ Stop button)
let nextId = 1;

/** Route a `stream_stop:<id>` button tap. @returns {boolean} whether it was one */
export function handleStopButton(data, chatId) {
  const m = /^stream_stop:(\d+)$/.exec(String(data || ''));
  if (!m) return false;
  const stream = byId.get(Number(m[1]));
  if (stream && String(stream.chatId) === String(chatId)) stream.stopByUser();
  return true;
}

export class EditStream {
  constructor(telegram, chatId, { threadId, throttleMs = EDIT_THROTTLE_MS } = {}) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.threadId = threadId;
    this.throttleMs = throttleMs;
    this.id = nextId++;
    this.controller = new AbortController();
    this.mode = 'edit';
    this.streaming = false;
    this.stopped = false;
    this.messageId = null;
    this.sending = null;      // the first send, while in flight
    this.shown = '';
    this.pending = null;
    this.lastEditAt = 0;
    this.inFlight = null;
    this.trailing = null;
    this.edits = 0;
  }

  get signal() { return this.controller.signal; }
  get stopMarkup() { return { inline_keyboard: [[{ text: '⏹ Stop', callback_data: `stream_stop:${this.id}` }]] }; }

  async start() { byId.set(this.id, this); return this; }
  async status() { /* the chat action already says "typing…"; no message until there is text */ }

  /** Same contract as DraftStream.progress; like status(), nothing is shown before text. */
  async progress(percent, label) { await this.status(progressBar(percent, label)); }

  async chunk(_delta, fullText) {
    this.streaming = true;
    if (this.stopped || !fullText) return;
    this.pending = fullText;
    if (!this.messageId) {
      if (!this.sending) this.sending = this._sendFirst();
      await this.sending;
      return;
    }
    const wait = this.throttleMs - (Date.now() - this.lastEditAt);
    if (this.inFlight || wait > 0) {
      if (!this.trailing) {
        this.trailing = setTimeout(() => { this.trailing = null; this._flush().catch(() => {}); }, Math.max(wait, 50));
        this.trailing.unref?.();
      }
      return;
    }
    await this._flush();
  }

  async _sendFirst() {
    const text = this.pending;
    this.pending = null;
    try {
      const msg = await this.telegram.sendMessage(this.chatId, clip(text + CURSOR), {
        reply_markup: this.stopMarkup,
        ...(this.threadId ? { message_thread_id: this.threadId } : {})
      });
      this.messageId = msg?.message_id ?? null;
      this.shown = text;
      this.lastEditAt = Date.now();
    } catch (err) {
      logger.warn(`[telegram] streaming message could not be sent, reply will arrive whole: ${err.message}`);
      this.mode = 'off';
    }
  }

  async _flush() {
    if (this.stopped || !this.messageId || this.pending === null || this.mode !== 'edit') return;
    const text = this.pending;
    this.pending = null;
    if (text === this.shown) return;
    this.inFlight = this._edit(clip(text + CURSOR), { reply_markup: this.stopMarkup })
      .then(ok => { if (ok) this.shown = text; })
      .finally(() => { this.inFlight = null; this.lastEditAt = Date.now(); });
    await this.inFlight;
  }

  /** @returns {Promise<boolean>} */
  async _edit(text, extra = {}) {
    try {
      await this.telegram.editMessageText(this.chatId, this.messageId, undefined, text, extra);
      this.edits++;
      return true;
    } catch (err) {
      if (/not modified/i.test(err.message)) return true;
      const retry = err?.response?.parameters?.retry_after;
      if (retry) { this.lastEditAt = Date.now() + retry * 1000; return false; }
      logger.warn(`[telegram] streaming edit failed: ${err.message}`);
      return false;
    }
  }

  async complete() { /* deliver() writes the final text */ }

  stopByUser() {
    if (this.stopped) return;
    this.stopped = true;
    logger.info(`[telegram] user stopped streamed reply ${this.id}`);
    this.controller.abort(new Error('Stopped by user'));
  }

  async _settle() {
    if (this.trailing) { clearTimeout(this.trailing); this.trailing = null; }
    this.pending = null;
    if (this.sending) await this.sending.catch(() => {});
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  /**
   * Make the streamed message the final reply. @returns {Promise<boolean>} true when the reply
   * is delivered (the caller must not send it again).
   */
  async deliver(finalText) {
    await this._settle();
    if (!this.messageId || this.mode !== 'edit') return false;
    const text = String(finalText || '');
    if (!text || text.length > TELEGRAM_TEXT_LIMIT) {
      try { await this.telegram.deleteMessage(this.chatId, this.messageId); } catch { /* gone */ }
      this.messageId = null;
      return false;
    }
    const clear = { reply_markup: { inline_keyboard: [] } };
    try {
      await this.telegram.editMessageText(this.chatId, this.messageId, undefined, text, { parse_mode: 'Markdown', ...clear });
      return true;
    } catch (err) {
      if (/not modified/i.test(err.message)) return true;
    }
    return this._edit(text, clear);
  }

  async finish() {
    await this._settle();
    byId.delete(this.id);
  }
}

/**
 * The reply stream for a chat. TELEGRAM_STREAM_TRANSPORT: edit (default) | draft | off.
 * Drafts only exist in private chats; anything else streams by edit.
 */
export function createReplyStream(telegram, chatId, opts = {}) {
  const transport = String(opts.transport || process.env.TELEGRAM_STREAM_TRANSPORT || 'edit').toLowerCase();
  if (transport === 'off') return new NullStream();
  if (transport === 'draft' && Number(chatId) > 0) return new DraftStream(telegram, chatId, opts);
  return new EditStream(telegram, chatId, opts);
}

/** Streaming disabled: the reply arrives whole, the chat action still shows "typing…". */
export class NullStream {
  constructor() { this.controller = new AbortController(); this.stopped = false; }
  get signal() { return this.controller.signal; }
  async start() { return this; }
  async status() {}
  async chunk() {}
  async complete() {}
  async deliver() { return false; }
  async finish() {}
}
