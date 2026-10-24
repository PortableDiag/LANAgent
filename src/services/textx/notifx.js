/**
 * NotifX: the owner's notification history app (Trellis NotifX › Agent Card 3051, "NotifX agent
 * frames v1", locked 2026-10-24; NotifX repo docs/agent-protocol-notifx.md, NotifX 0.3.0). NotifX
 * speaks TextX Agent Protocol v1 unchanged, so a NotifX pairing is a TextX pairing whose hello lists
 * `notifx.*` tools.
 *
 *   agent → phone  notifx.list_apps / list_channels / search / get_notification / list_active /
 *                  get_picture (Read), watch / unwatch / list_watches (Watch), reply / tap_action
 *                  (Act, the owner confirms on the phone), dismiss.
 *   phone → agent  event {kind:"notification.posted", watch_id, notification, updated?, dropped?, picture?}
 *
 * The phone owns every limit that matters: the per-agent app list (empty by default), withheld
 * one-time codes, rate limits, and the watch filter itself, so a notification that matches no watch
 * never leaves the phone. The agent's side: a watch the owner set to be told ("tell me when someone
 * rings the doorbell") goes straight to Telegram with no model call, because notification text is
 * someone else's words (`untrusted: true`) and personal messages must not reach an AI provider
 * unless the owner asks about them.
 */

export const NOTIFX_TOOLS = ['notifx.list_apps', 'notifx.list_channels', 'notifx.search', 'notifx.get_notification',
  'notifx.list_active', 'notifx.get_picture', 'notifx.watch', 'notifx.unwatch', 'notifx.list_watches',
  'notifx.reply', 'notifx.tap_action', 'notifx.dismiss'];
/** These wait on the owner's tap on the phone, like a send. */
export const NOTIFX_CONFIRMED = new Set(['notifx.reply', 'notifx.tap_action']);

/** A NotifX pairing: minted for NotifX, says it is NotifX, or its hello listed NotifX tools. */
export function isNotifX(device) {
  return device?.app === 'notifx' || /notifx/i.test(String(device?.client || '')) || (device?.capabilities || []).some(t => NOTIFX_TOOLS.includes(t));
}

/** The same notification reported by two phones (each with its own watch) is told once. */
const DUPLICATE_MS = 2 * 60 * 1000;

/** Telegram allows 1024 characters in a photo caption. */
const CAPTION_MAX = 1000;
/** NotifX scales a picture to ≤ 256 KB; anything far past that is not what the doc promised. */
const PICTURE_MAX = 400 * 1024;

/** The alert the owner reads: the watch's name, then the notification as the app wrote it. */
export function alertText(n = {}, { name, dropped, updated, phone } = {}) {
  const app = String(n.app || n.package || 'An app').trim();
  const title = String(n.title || '').trim();
  const text = String(n.text || '').trim();
  // "Doorbell (Work OnePlus)" when several phones are paired (NotifX #11), else "Doorbell (Ring)".
  const label = name && name.toLowerCase() !== app.toLowerCase() ? name : app;
  const head = phone ? `${label} (${phone})` : (label === app ? app : `${label} (${app})`);
  let s = `🔔 ${head}${updated ? ' (updated)' : ''}: ${title}${title && text ? ' — ' : ''}${text}`.trim();
  if (Number(dropped) > 0) s += `\n(${dropped} earlier match${dropped === 1 ? ' was' : 'es were'} dropped by the phone's rate limit.)`;
  return s.length > CAPTION_MAX ? `${s.slice(0, CAPTION_MAX - 1)}…` : s;
}

/** The event's picture as a Buffer, or null when it is missing or not the JPEG the doc promises. */
export function pictureOf(att) {
  if (!att?.data_b64 || !/^image\//i.test(String(att.mime || ''))) return null;
  try {
    const buf = Buffer.from(String(att.data_b64), 'base64');
    return buf.length > 0 && buf.length <= PICTURE_MAX ? buf : null;
  } catch { return null; }
}

/**
 * The agent's own record of each watch it set (the phone keeps the filter; this keeps why). Stored
 * on the pairing as `notifxWatches: [{watchId, name, packages, silent, createdAt}]`.
 */
export class NotifXWatches {
  constructor({ hub, agent, logger = console } = {}) {
    this.hub = hub;
    this.agent = agent;
    this.logger = logger;
    this.recent = new Map(); // dedupe key -> time first told
  }

  /** What the owner calls this phone: the event's, else the last hello's. */
  phoneName(device, body) {
    return String(body?.phone?.name || device.phoneName || device.name || '').trim();
  }

  /** True when this notification was already told from another phone a moment ago. */
  duplicate(device, n, now = Date.now()) {
    for (const [k, t] of this.recent) if (now - t > DUPLICATE_MS) this.recent.delete(k);
    const key = [n.package, n.title, n.text, n.posted_at].map(v => String(v ?? '')).join('\u0000');
    const seen = this.recent.get(key);
    if (seen != null && now - seen <= DUPLICATE_MS) return true;
    this.recent.set(key, now);
    return false;
  }

  async notifxPhones() {
    return (await this.hub.store.listDevices()).filter(d => !d.revokedAt && d.deviceId && isNotifX(d));
  }

  async remember(device, watch, meta = {}) {
    const list = (device.notifxWatches || []).filter(w => w.watchId !== watch.watch_id);
    list.push({ watchId: watch.watch_id, name: String(meta.name || watch.name || '').slice(0, 80),
      packages: watch.packages || meta.packages || [], silent: !!meta.silent, createdAt: new Date() });
    Object.assign(device, await this.hub.store.updateDevice(device.id, { notifxWatches: list }));
  }

  async forget(device, watchId) {
    const list = (device.notifxWatches || []).filter(w => w.watchId !== watchId);
    Object.assign(device, await this.hub.store.updateDevice(device.id, { notifxWatches: list }));
  }

  meta(device, watchId) {
    return (device.notifxWatches || []).find(w => w.watchId === watchId) || null;
  }

  /** A watch matched on the phone: tell the owner. No model sees the text. */
  async onEvent(device, body) {
    if (body.kind !== 'notification.posted' || !body.notification) return;
    const n = body.notification;
    const meta = this.meta(device, body.watch_id);
    if (this.duplicate(device, n)) {
      this.logger.info?.(`NotifX: watch ${meta?.name ? `"${meta.name}"` : body.watch_id || '?'} on ${this.phoneName(device, body)} matched a notification another phone already reported`);
      return;
    }
    const several = (await this.notifxPhones()).length > 1;
    const text = alertText(n, { name: meta?.name, dropped: body.dropped, updated: body.updated, phone: several ? this.phoneName(device, body) : null });
    const photo = pictureOf(body.picture);
    // Content never goes in the log, only which watch fired.
    this.logger.info?.(`NotifX: watch ${meta?.name ? `"${meta.name}"` : body.watch_id || '?'} matched (${n.package || 'unknown app'})` +
      `${photo ? `, picture ${Math.round(photo.length / 1024)} KB` : ''}${body.dropped ? `, ${body.dropped} dropped` : ''}`);
    const urgent = !meta?.silent;
    const tg = this.agent?.interfaces?.get?.('telegram');
    if (tg?.sendNotification) {
      try {
        const ok = await tg.sendNotification(text, { ...(photo ? { photo: { source: photo, filename: 'picture.jpg' } } : {}), parse_mode: undefined, urgent });
        if (ok !== false) return;
      } catch (e) {
        this.logger.warn?.(`NotifX: Telegram alert failed: ${e.message}`);
      }
    }
    await this.agent?.notify?.(text, { urgent });
  }
}
