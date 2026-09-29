import { logger } from '../../utils/logger.js';

/**
 * "typing…" (and "sending photo…", "recording voice…") while the bot works on a request.
 *
 * Telegram shows a chat action for about 5 seconds, or until the bot sends a message, so a
 * single sendChatAction is gone long before a multi-step request finishes. This keeps it
 * alive for exactly as long as the update's handler runs, and switches it to the upload
 * action matching whatever the handler is about to send.
 *
 * The first action waits START_DELAY_MS: a menu tap that edits a message in 100ms would
 * otherwise leave "typing…" on screen for 5 seconds after it finished, because an edit does
 * not clear it the way a new message does.
 */

export const CHAT_ACTION_INTERVAL_MS = 4000;
export const CHAT_ACTION_START_DELAY_MS = 600;

/** Which chat action each ctx send method implies (Bot API sendChatAction actions). */
export const MEDIA_ACTIONS = {
  replyWithPhoto: 'upload_photo',
  replyWithMediaGroup: 'upload_photo',
  replyWithDocument: 'upload_document',
  replyWithVoice: 'upload_voice',
  replyWithAudio: 'upload_voice',
  replyWithVideo: 'upload_video',
  replyWithAnimation: 'upload_video',
  replyWithVideoNote: 'upload_video_note',
  replyWithSticker: 'choose_sticker',
  replyWithLocation: 'find_location'
};

/** Methods that deliver a message: the next action waits a full interval after one. */
const TEXT_SENDS = ['reply', 'replyWithHTML', 'replyWithMarkdown', 'replyWithMarkdownV2'];

/** A user message or a button press in a real chat — not channel posts, edits or joins. */
export function shouldShowActivity(ctx) {
  if (!ctx?.chat?.id) return false;
  if (ctx.callbackQuery) return true;
  const m = ctx.message;
  if (!m) return false;
  return Boolean(m.text || m.voice || m.audio || m.photo || m.document || m.video || m.video_note || m.caption);
}

export class ChatActionKeepalive {
  constructor(ctx, { interval = CHAT_ACTION_INTERVAL_MS, startDelay = CHAT_ACTION_START_DELAY_MS } = {}) {
    this.ctx = ctx;
    this.interval = interval;
    this.startDelay = startDelay;
    this.action = 'typing';
    this.timer = null;
    this.stopped = false;
    this.sent = 0;
    this._send = typeof ctx.sendChatAction === 'function' ? ctx.sendChatAction.bind(ctx) : null;
  }

  start() {
    if (!this._send) return this;
    this._schedule(this.startDelay);
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule(ms) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick(), ms);
    this.timer.unref?.();
  }

  async _tick() {
    if (this.stopped) return;
    await this._emit();
    this._schedule(this.interval);
  }

  async _emit() {
    if (this.stopped || !this._send) return;
    try {
      await this._send(this.action);
      this.sent++;
    } catch (err) {
      // Blocked bot, deleted chat, no rights in a group: nothing more to show here.
      const code = err?.response?.error_code ?? err?.code;
      if (code === 403 || code === 400) this.stop();
      logger.debug(`[telegram] chat action ${this.action} failed: ${err?.message || err}`);
    }
  }

  /** Switch the action now (e.g. to upload_photo just before sending one). */
  async set(action) {
    this.action = action;
    if (this.stopped) return;
    await this._emit();
    this._schedule(this.interval);
  }

  /** A message just arrived in the chat and cleared the action; resume typing a full interval later. */
  _afterSend() {
    this.action = 'typing';
    this._schedule(this.interval);
  }

  /**
   * Wrap the ctx send methods so uploads show the right action and every send resets the
   * timer. Also makes a handler's own ctx.sendChatAction('record_voice') stick instead of
   * being replaced by "typing" on the next tick.
   */
  install() {
    const ctx = this.ctx;
    const wrap = (name, before) => {
      const original = ctx[name];
      if (typeof original !== 'function') return;
      ctx[name] = async (...args) => {
        if (before) await before();
        try {
          return await original.apply(ctx, args);
        } finally {
          this._afterSend();
        }
      };
    };
    for (const [name, action] of Object.entries(MEDIA_ACTIONS)) wrap(name, () => this.set(action));
    for (const name of TEXT_SENDS) wrap(name);

    if (this._send) {
      ctx.sendChatAction = async (action, extra) => {
        this.action = action;
        this._schedule(this.interval);
        return this._send(action, extra);
      };
    }
    return this;
  }
}

/** Telegraf middleware: shows the chat action for as long as the rest of the chain runs. */
export function chatActionMiddleware(options = {}) {
  return async (ctx, next) => {
    if (!shouldShowActivity(ctx)) return next();
    const keepalive = new ChatActionKeepalive(ctx, options).install().start();
    const started = Date.now();
    try {
      return await next();
    } finally {
      keepalive.stop();
      if (keepalive.sent) {
        logger.info(`[telegram] chat action shown for ${((Date.now() - started) / 1000).toFixed(1)}s (${keepalive.sent} sent, last ${keepalive.action})`);
      }
    }
  };
}
