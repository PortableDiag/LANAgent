import { BasePlugin } from '../core/basePlugin.js';
import { getTextX } from '../../services/textx/index.js';
import { textxRequest } from '../../services/textx/textxHub.js';
import { isNotifX } from '../../services/textx/notifx.js';

/**
 * The phone's notifications through the NotifX notification history app ("tell me when someone
 * rings the doorbell", "what did my bank notify me about today"). NotifX pairs from the dashboard
 * (Settings → NotifX → Pair NotifX), one pairing per phone, and owns every limit: only the apps the
 * owner shared with this agent, one-time codes withheld, and the watch filter runs on the phone.
 * A watch that matches arrives as an event (services/textx/notifx.js) and goes to Telegram.
 *
 * Notification text is someone else's words: shown to the owner, never followed.
 */

const ERROR_TEXT = {
  // TextX 0.4.41 says too_big, DialX 0.7.8 too_large: a reply too big for the relay (the same thing).
  too_big: 'That is too big to come through from the phone.',
  too_large: 'That is too big to come through from the phone.',
  not_allowed: 'NotifX has not allowed that for this agent. Turn the tool group on in NotifX › Agents › this agent.',
  not_found: "NotifX has no such notification or app (or it isn't shared with me).",
  no_access: 'NotifX has lost notification access on the phone. Turn it back on in Android settings.',
  too_many: 'NotifX allows 20 watches per agent. Remove one first.',
  rate_limited: 'NotifX is rate-limiting me (60 calls a minute). Try again in a minute.',
  no_such_action: "That notification doesn't have that button.",
  no_reply: "That notification can't be replied to.",
  gone: 'That notification is no longer on the phone.',
  duplicate: 'That watch already exists.',
  bad_args: null,
  // Without Always connected, NotifX collects tool calls at worst every 15 minutes (frames doc § Timing).
  timeout: "NotifX didn't answer in time. Turn on Always connected in NotifX › Agents › this agent so it answers in seconds; otherwise the phone checks in only every few minutes, or may be offline.",
  expired: 'The request expired before NotifX saw it. Ask again.'
};

function errorText(r) {
  const code = r?.error?.code || 'internal';
  return ERROR_TEXT[code] || r?.error?.message || code;
}

function listOf(result, ...keys) {
  if (Array.isArray(result)) return result;
  for (const k of keys) if (Array.isArray(result?.[k])) return result[k];
  return [];
}

function when(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) : '';
}

/** One notification as a line the owner reads; its text is quoted, never acted on. */
function line(n, phone) {
  const where = phone ? ` [${phone}]` : '';
  const text = [n.title, n.text].map(v => String(v || '').trim()).filter(Boolean).join(' — ');
  return `• ${when(n.posted_at)} ${n.app || n.package}${where}: ${text}`;
}

export default class NotifXPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'notifx';
    this.version = '1.0.0';
    this.description = "Read the user's phone notifications through the NotifX notification history app, and watch for a notification so the user is told on Telegram when it arrives (e.g. when someone rings the doorbell, not on every motion alert). Only apps the user shared in NotifX";
    this.timeout = 120000;
    this.commands = [
      {
        command: 'watch',
        description: 'Tell the user on Telegram whenever a notification like this arrives. `app` is the app ("Ring"), `name` a short label for the alert ("Doorbell"), and optional filters: `textContains`/`textExcludes` (words in the title or text), `channel` (the app\'s notification channel id). With no filter, the agent picks one from the app\'s notification history. `phone` limits it to one paired phone',
        usage: 'watch({ app: "Ring", name: "Doorbell", textContains: "doorbell", textExcludes: "motion" })',
        examples: ['tell me when someone rings the doorbell', 'let me know when my package is delivered', 'notify me when the bank sends a fraud alert', 'tell me when ring detects a person, not motion']
      },
      {
        command: 'unwatch',
        description: 'Stop a notification watch (stop telling the user on Telegram when an app\'s notification arrives), by its name, app or id',
        usage: 'unwatch({ name: "Doorbell" })',
        examples: ['stop telling me about the doorbell', 'remove the delivery watch', 'disable the telegram notification for ring doorbell alerts', 'stop the doorbell alerts', 'stop watching ring notifications', 'turn off the notification watch for my bank']
      },
      {
        command: 'watches',
        description: 'List the notification watches set on the paired NotifX phones',
        usage: 'watches()',
        examples: ['what notifications are you watching for', 'list my notification watches']
      },
      {
        command: 'search',
        description: 'Search the phone\'s notification history (newest first). `query` is full-text, `app` narrows to one app, `since` an ISO time',
        usage: 'search({ query: "delivered", app: "Amazon", since: "2026-10-24T00:00:00Z", limit: 20 })',
        examples: ['what notifications did I get from my bank today', 'search my notifications for delivered', 'did ring notify me this morning', 'show my recent notifications']
      },
      {
        command: 'active',
        description: 'The notifications on the phone\'s status bar right now, with their buttons',
        usage: 'active({ app: "Ring" })',
        examples: ['what notifications are on my phone right now', 'any notifications waiting']
      },
      {
        command: 'apps',
        description: 'Which apps the user shared with the agent in NotifX, with notification counts',
        usage: 'apps()',
        examples: ['which apps can you see notifications from', 'what apps are shared in notifx']
      },
      {
        command: 'channels',
        description: 'An app\'s notification channels from the history, with a recent title for each (to pick a watch filter)',
        usage: 'channels({ app: "Ring" })',
        examples: ['what notification channels does ring use']
      },
      {
        command: 'picture',
        description: 'Send the user the picture attached to a notification still on the phone (e.g. the doorbell snapshot). `key` from active(), or `app` for that app\'s newest one with a picture',
        usage: 'picture({ app: "Ring" })',
        examples: ['send me the doorbell picture', 'show me the picture from that ring notification', 'what does the camera snapshot show']
      },
      {
        command: 'reply',
        description: 'Reply through a notification\'s own reply box (the user confirms on the phone). `key` from active()',
        usage: 'reply({ key: "0|com.whatsapp|…", text: "On my way", phone: "OnePlus" })',
        examples: ['reply to that notification saying on my way']
      },
      {
        command: 'tap',
        description: 'Press a button on a notification (the user confirms on the phone). `key` and `action` (index or title) from active()',
        usage: 'tap({ key: "…", action: "Mark as read" })',
        examples: ['press mark as read on that notification']
      },
      {
        command: 'dismiss',
        description: 'Dismiss a notification from the status bar (it stays in the history). `key` from active()',
        usage: 'dismiss({ key: "…" })',
        examples: ['dismiss that notification']
      }
    ];
  }

  get hub() { return getTextX(this.agent).hub; }

  async execute(params = {}) {
    const { action, ...data } = params;
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can use their phone notifications.' };
    try {
      switch (action) {
        case 'watch': return await this.watch(data);
        case 'unwatch': return await this.unwatch(data);
        case 'watches': return await this.watches();
        case 'search': return await this.search(data);
        case 'active': return await this.active(data);
        case 'apps': return await this.apps();
        case 'channels': return await this.channels(data);
        case 'picture': return await this.picture(data);
        case 'reply': return await this.act('notifx.reply', data, { text: String(data.text || data.message || '') });
        case 'tap': return await this.act('notifx.tap_action', data, {});
        case 'dismiss': return await this.act('notifx.dismiss', data, {});
        default: return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (error) {
      this.logger.error(`notifx ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /** Notifications are the owner's: a TextX phone of theirs, Telegram as them, or the dashboard. */
  fromOwner(data) {
    const uid = data._context?.userId;
    // 'web-user' is the logged-in dashboard and the API key (POST /api/command/execute); refusing it
    // turned the owner away from their own dashboard (2026-10-24).
    return !!textxRequest.getStore()?.deviceId || !uid || uid === 'web-user' || String(uid) === String(process.env.TELEGRAM_USER_ID || '');
  }

  // ── phones ────────────────────────────────────────────────────────────────────────────────

  async phones() {
    return (await this.hub.store.listDevices()).filter(d => !d.revokedAt && d.deviceId && isNotifX(d));
  }

  label(d) { return d.phoneName || d.name; }

  /** The phones a request is for: the one named, else every paired NotifX phone. */
  async targets(phone) {
    const all = await this.phones();
    if (!all.length) return { error: 'No NotifX phone is paired. Pair one in the dashboard: Settings → NotifX → Pair NotifX.' };
    if (!phone) return { list: all };
    const q = String(phone).toLowerCase();
    const hit = all.filter(d => [d.phoneName, d.name].some(v => String(v || '').toLowerCase().includes(q)));
    if (!hit.length) return { error: `No paired NotifX phone is called "${phone}". Paired: ${all.map(d => this.label(d)).join(', ')}.` };
    return { list: hit };
  }

  tool(device, name, args = {}, opts = {}) {
    if (!(device.capabilities || []).includes(name)) {
      return Promise.resolve({ ok: false, error: { code: 'not_allowed' } });
    }
    return this.hub.callTool(name, args, { deviceId: device.id, onlyDevice: device.id, ...opts });
  }

  /** The same tool on each phone; phones that refuse are reported, not fatal. */
  async onEach(list, name, args) {
    const out = await Promise.all(list.map(async d => ({ d, r: await this.tool(d, name, args) })));
    const ok = out.filter(x => x.r.ok);
    const failed = out.filter(x => !x.r.ok).map(x => `${this.label(x.d)}: ${errorText(x.r)}`);
    return { ok, failed, several: list.length > 1 };
  }

  /**
   * Which phones an answer came from, and which could not be read. Without it "which device did you
   * check?" had no answer, and a phone that failed vanished while the other answered (2026-10-24).
   */
  checked({ ok, failed }) {
    const names = ok.map(x => this.label(x.d)).join(' and ');
    return `${names ? `Checked: ${names}.` : ''}${failed.length ? ` Could not read ${failed.join('; ')}.` : ''}`.trim();
  }

  /** "Ring" → com.ringapp, from what the owner shared. */
  async packageFor(list, app) {
    if (!app) return null;
    const q = String(app).toLowerCase().trim();
    if (q.includes('.')) return q;
    const { ok } = await this.onEach(list, 'notifx.list_apps', {});
    const apps = ok.flatMap(x => listOf(x.r.result, 'apps'));
    const hit = apps.find(a => String(a.label || '').toLowerCase() === q) ||
      apps.find(a => String(a.label || '').toLowerCase().includes(q) || String(a.package || '').toLowerCase().includes(q));
    return hit ? hit.package : { error: `"${app}" isn't one of the apps shared with me in NotifX${apps.length ? ` (shared: ${[...new Set(apps.map(a => a.label || a.package))].join(', ')})` : ''}. Share it in NotifX › Agents › this agent › Apps.` };
  }

  // ── reading ───────────────────────────────────────────────────────────────────────────────

  async apps() {
    const t = await this.targets();
    if (t.error) return { success: false, error: t.error };
    const { ok, failed, several } = await this.onEach(t.list, 'notifx.list_apps', {});
    if (!ok.length) return { success: false, error: failed.join('; ') };
    const rows = ok.flatMap(x => listOf(x.r.result, 'apps').map(a =>
      `• ${a.label || a.package}${several ? ` [${this.label(x.d)}]` : ''}: ${a.count ?? 0} notifications${a.last_at ? `, last ${when(a.last_at)}` : ''}`));
    return { success: true, result: rows.length ? `Apps shared with me in NotifX:\n${rows.join('\n')}` : 'No apps are shared with me in NotifX yet. Pick them in NotifX › Agents › this agent › Apps.' };
  }

  async channels(data) {
    const t = await this.targets(data.phone);
    if (t.error) return { success: false, error: t.error };
    const pkg = await this.packageFor(t.list, data.app || data.package);
    if (!pkg || pkg.error) return { success: false, error: pkg?.error || 'Which app?' };
    const { ok, failed } = await this.onEach(t.list, 'notifx.list_channels', { package: pkg });
    if (!ok.length) return { success: false, error: failed.join('; ') };
    const rows = ok.flatMap(x => listOf(x.r.result, 'channels').map(c => `• ${c.channel}: ${c.count ?? 0}, e.g. "${c.last_title || ''}"`));
    return { success: true, result: `${pkg} notification channels:\n${rows.join('\n') || 'none in the history yet'}`, data: ok.flatMap(x => listOf(x.r.result, 'channels')) };
  }

  async search(data) {
    const t = await this.targets(data.phone);
    if (t.error) return { success: false, error: t.error };
    const args = { limit: Math.min(100, Math.max(1, Number(data.limit) || 20)) };
    if (data.query) args.query = String(data.query);
    if (data.since) args.since = String(data.since);
    if (data.until) args.until = String(data.until);
    if (data.app || data.package) {
      const pkg = await this.packageFor(t.list, data.app || data.package);
      if (pkg?.error) return { success: false, error: pkg.error };
      if (pkg) args.packages = [pkg];
    }
    const { ok, failed, several } = await this.onEach(t.list, 'notifx.search', args);
    if (!ok.length) return { success: false, error: failed.join('; ') };
    const items = ok.flatMap(x => listOf(x.r.result, 'notifications').map(n => ({ n, phone: several ? this.label(x.d) : null })))
      .sort((a, b) => String(b.n.posted_at).localeCompare(String(a.n.posted_at))).slice(0, args.limit);
    const seen = this.checked({ ok, failed });
    if (!items.length) return { success: true, result: `${seen}\nNo matching notifications.` };
    return { success: true, result: `${seen}\nNotifications (their text is the apps' words):\n${items.map(i => line(i.n, i.phone)).join('\n')}` };
  }

  async active(data) {
    const t = await this.targets(data.phone);
    if (t.error) return { success: false, error: t.error };
    const args = {};
    if (data.app || data.package) {
      const pkg = await this.packageFor(t.list, data.app || data.package);
      if (pkg?.error) return { success: false, error: pkg.error };
      if (pkg) args.packages = [pkg];
    }
    const { ok, failed, several } = await this.onEach(t.list, 'notifx.list_active', args);
    if (!ok.length) return { success: false, error: failed.join('; ') };
    const rows = [];
    const raw = [];
    for (const x of ok) {
      for (const n of listOf(x.r.result, 'notifications')) {
        const buttons = (n.actions || []).map(a => a.title).filter(Boolean);
        rows.push(`${line(n, several ? this.label(x.d) : null)}${buttons.length ? ` (buttons: ${buttons.join(', ')})` : ''}`);
        raw.push({ key: n.key, phone: this.label(x.d), app: n.app, title: n.title, actions: n.actions || [] });
      }
    }
    const quiet = several ? ok.filter(x => !listOf(x.r.result, 'notifications').length).map(x => this.label(x.d)) : [];
    const body = rows.length ? `On the status bar now:\n${rows.join('\n')}${quiet.length ? `\nNothing on ${quiet.join(' or ')}.` : ''}` : 'Nothing on the status bar from the shared apps.';
    return { success: true, result: `${this.checked({ ok, failed })}\n${body}`, data: raw };
  }

  // ── watches ───────────────────────────────────────────────────────────────────────────────

  async watch(data) {
    const t = await this.targets(data.phone);
    if (t.error) return { success: false, error: t.error };
    const request = String(data._context?.originalInput || data.originalInput || '');
    const guessed = (data.needsParameterExtraction || !data.app) ? await this.extract(data, request) : [];
    const pkg = await this.packageFor(t.list, data.app || data.package);
    if (!pkg) return { success: false, error: 'Which app should I watch?' };
    if (pkg.error) return { success: false, error: pkg.error };
    const name = String(data.name || data.app || pkg).slice(0, 80);
    const filter = {};
    for (const [k, f] of [['textContains', 'text_contains'], ['textExcludes', 'text_excludes'], ['titleContains', 'title_contains']]) {
      const v = data[k] ?? data[f];
      if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) filter[f] = v;
    }
    if (data.channel) filter.channel = String(data.channel);
    if (data.regex) filter.regex = String(data.regex).slice(0, 200);
    // No condition the user stated: choose one from what this app actually posts, so "when someone
    // rings" does not mean every motion alert. Words the model guessed from the request lose to the
    // history: it guessed "doorbell" for Ring, whose ding reads "Someone is at your Front Door", so
    // that watch could never fire (2026-10-24).
    let picked = null;
    const stated = Object.keys(filter).filter(f => !guessed.includes({ text_contains: 'textContains', text_excludes: 'textExcludes', title_contains: 'titleContains' }[f]));
    if (!stated.length && request) {
      picked = await this.pickFilter(t.list, pkg, request);
      if (picked) { for (const k of Object.keys(filter)) delete filter[k]; Object.assign(filter, picked); }
    }
    // Whoever chose the words, a filter that matches none of the app's past notifications is
    // checked against the history, and the app's own channel replaces it when one fits. The intent
    // detector also hands over guessed words ("doorbell") as if the user had said them.
    if (!picked && filter.text_contains && !filter.channel && request && !(await this.matchesHistory(t.list, pkg, filter.text_contains))) {
      picked = await this.pickFilter(t.list, pkg, request);
      if (picked) { for (const k of Object.keys(filter)) delete filter[k]; Object.assign(filter, picked); }
    }
    const args = { packages: [pkg], name, ...filter, include_picture: data.picture !== false };
    const set = [];
    const failed = [];
    for (const d of t.list) {
      const r = await this.tool(d, 'notifx.watch', args);
      if (!r.ok) { failed.push(`${this.label(d)}: ${errorText(r)}`); continue; }
      await this.hub.notifx.remember(d, { ...r.result, packages: [pkg] }, { name, silent: !!data.silent });
      set.push(this.label(d));
    }
    if (!set.length) return { success: false, error: failed.join('; ') };
    const how = Object.entries(filter).map(([k, v]) => `${k.replace('_', ' ')} ${Array.isArray(v) ? v.join('/') : v}`).join(', ') || 'every notification';
    return { success: true, result: `I'll tell you on Telegram when ${name} notifies (${how})${t.list.length > 1 ? `, on ${set.join(' and ')}` : ''}.` +
      `${picked ? ' I picked that filter from its recent notifications; tell me if it catches the wrong ones.' : ''}${failed.length ? ` Not set on ${failed.join('; ')}.` : ''}` };
  }

  async unwatch(data) {
    const t = await this.targets(data.phone);
    if (t.error) return { success: false, error: t.error };
    const q = String(data.name || data.watchId || data.watch_id || data.app || '').toLowerCase();
    if (!q) return { success: false, error: 'Which watch should I remove?' };
    const removed = [];
    for (const d of t.list) {
      const r = await this.tool(d, 'notifx.list_watches', {});
      const list = r.ok ? listOf(r.result, 'watches') : [];
      for (const w of list) {
        const meta = this.hub.notifx.meta(d, w.watch_id);
        const names = [w.watch_id, w.name, meta?.name, ...(w.packages || [])].map(v => String(v || '').toLowerCase());
        if (!names.some(v => v && (v === q || v.includes(q)))) continue;
        const u = await this.tool(d, 'notifx.unwatch', { watch_id: w.watch_id });
        if (u.ok || u.error?.code === 'not_found') { await this.hub.notifx.forget(d, w.watch_id); removed.push(`${meta?.name || w.name || w.watch_id} (${this.label(d)})`); }
      }
    }
    return removed.length ? { success: true, result: `Stopped watching: ${removed.join(', ')}.` } : { success: false, error: `No watch matches "${q}".` };
  }

  async watches() {
    const t = await this.targets();
    if (t.error) return { success: false, error: t.error };
    const { ok, failed, several } = await this.onEach(t.list, 'notifx.list_watches', {});
    if (!ok.length) return { success: false, error: failed.join('; ') };
    const rows = ok.flatMap(x => listOf(x.r.result, 'watches').map(w => {
      const meta = this.hub.notifx.meta(x.d, w.watch_id);
      const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
      const cond = ['title_contains', 'text_contains', 'text_excludes', 'channel', 'regex'].filter(k => !empty(w[k])).map(k => `${k.replace('_', ' ')} ${Array.isArray(w[k]) ? w[k].join('/') : w[k]}`).join(', ');
      return `• ${meta?.name || w.name || w.watch_id}${several ? ` [${this.label(x.d)}]` : ''}: ${(w.packages || []).join(', ')}${cond ? ` (${cond})` : ''}`;
    }));
    return { success: true, result: rows.length ? `Watching for:\n${rows.join('\n')}` : 'No notification watches are set.' };
  }

  /** A status-bar notification's picture to Telegram (NotifX keeps no pictures in its history). */
  async picture(data) {
    const t = await this.targets(data.phone);
    if (t.error) return { success: false, error: t.error };
    let device = null;
    let key = data.key ? String(data.key) : null;
    if (!key) {
      const args = {};
      if (data.app || data.package) {
        const pkg = await this.packageFor(t.list, data.app || data.package);
        if (pkg?.error) return { success: false, error: pkg.error };
        if (pkg) args.packages = [pkg];
      }
      const { ok } = await this.onEach(t.list, 'notifx.list_active', args);
      const withPic = ok.flatMap(x => listOf(x.r.result, 'notifications').filter(n => n.picture).map(n => ({ n, d: x.d })))
        .sort((a, b) => String(b.n.posted_at).localeCompare(String(a.n.posted_at)));
      if (!withPic.length) return { success: false, error: 'No notification with a picture is on the phone right now (pictures are not kept in the history).' };
      key = withPic[0].n.key;
      device = withPic[0].d;
    }
    device ||= t.list[0];
    const r = await this.tool(device, 'notifx.get_picture', { key });
    if (!r.ok) return { success: false, error: errorText(r) };
    const buf = r.result?.data_b64 ? Buffer.from(r.result.data_b64, 'base64') : null;
    if (!buf?.length) return { success: false, error: 'NotifX sent no picture.' };
    const tg = this.agent?.interfaces?.get?.('telegram');
    if (!tg?.sendNotification) return { success: false, error: "Telegram isn't available to send it." };
    await tg.sendNotification(`🖼️ Picture from a notification on ${this.label(device)}`, { photo: { source: buf, filename: 'picture.jpg' }, parse_mode: undefined });
    return { success: true, result: 'Sent the picture to you on Telegram.' };
  }

  // ── acting (reply and tap wait on the owner's tap on the phone) ───────────────────────────

  async act(name, data, extra) {
    if (!data.key) return { success: false, error: 'Which notification? Ask me what is on the status bar first.' };
    const t = await this.targets(data.phone);
    if (t.error) return { success: false, error: t.error };
    if (t.list.length > 1 && !data.phone) return { success: false, error: `Which phone? ${t.list.map(d => this.label(d)).join(' or ')}.` };
    const args = { key: String(data.key), ...extra };
    if (data.action != null) args.action = /^\d+$/.test(String(data.action)) ? Number(data.action) : String(data.action);
    if (name === 'notifx.reply' && !args.text) return { success: false, error: 'What should the reply say?' };
    const r = await this.tool(t.list[0], name, args, {
      onLate: (late) => this.agent.notify?.(late.ok ? `🔔 NotifX: ${late.result?.status || 'done'}.` : `⚠️ NotifX: ${errorText(late)}`)
    });
    if (!r.ok) return { success: false, error: errorText(r) };
    if (r.pending) return { success: true, result: 'Waiting for you to confirm on the phone.' };
    const status = r.result?.status;
    const said = { sent: 'Reply sent.', pressed: 'Pressed.', dismissed: 'Dismissed (it stays in the history).', declined: 'You declined it on the phone.', timeout: "It wasn't confirmed on the phone in time." };
    return { success: true, result: said[status] || `NotifX: ${status || 'done'}.` };
  }

  // ── the model, for arguments only ─────────────────────────────────────────────────────────

  /** Fills what the request leaves out; returns the keys it filled (guesses, not the user's words). */
  async extract(data, request) {
    const filled = [];
    const pm = this.agent?.providerManager;
    if (!request || !pm?.generateResponse) return filled;
    try {
      const res = await pm.generateResponse(
        `The user asked: ${request}\nThey want to be told when a phone notification arrives. Extract one JSON object ` +
        '{"app": the app that posts it ("Ring", "Amazon"), "name": a short label for the alert ("Doorbell", "Delivery"), ' +
        '"textContains": words that only the wanted notification has, or null, "textExcludes": words of the ones they do NOT want, or null}. ' +
        'Leave out what the request does not say. Answer the JSON only.', { maxTokens: 150, temperature: 0 });
      const raw = String(res?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
      const got = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) || {};
      for (const k of ['app', 'name', 'textContains', 'textExcludes']) {
        if ((data[k] == null || data[k] === '') && got[k] != null && got[k] !== '') { data[k] = got[k]; filled.push(k); }
      }
    } catch (err) {
      this.logger.warn(`notifx watch: argument extraction failed: ${err.message}`);
    }
    delete data.needsParameterExtraction;
    return filled;
  }

  /** Has this app ever posted a notification with these words? A failed search counts as yes. */
  async matchesHistory(list, pkg, words) {
    for (const w of (Array.isArray(words) ? words : [words]).map(String).filter(Boolean)) {
      const { ok } = await this.onEach(list, 'notifx.search', { query: w, packages: [pkg], limit: 1 });
      if (!ok.length || ok.some(x => listOf(x.r.result, 'notifications').length)) return true;
    }
    return false;
  }

  /**
   * A filter from the app's own history: its channels and a recent title for each. The owner asked
   * for this watch, so showing the model those titles is theirs to ask; only titles, never texts.
   */
  async pickFilter(list, pkg, request) {
    const pm = this.agent?.providerManager;
    if (!pm?.generateResponse) return null;
    const { ok } = await this.onEach(list, 'notifx.list_channels', { package: pkg });
    const channels = ok.flatMap(x => listOf(x.r.result, 'channels'));
    if (!channels.length) return null;
    try {
      const res = await pm.generateResponse(
        `The user asked: ${request}\nThe app's notification channels, each with its most recent title:\n` +
        channels.map(c => `- ${c.channel} (${c.count ?? 0}): ${String(c.last_title || '').slice(0, 120) || '(no title)'}`).join('\n') +
        '\nWhich ONE channel carries the notifications they want? Answer JSON {"channel": the id, or null if none clearly fits}.',
        { maxTokens: 60, temperature: 0 });
      const raw = String(res?.content || '');
      const got = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) || {};
      return got.channel && channels.some(c => c.channel === got.channel) ? { channel: got.channel } : null;
    } catch (err) {
      this.logger.warn(`notifx watch: filter pick failed: ${err.message}`);
      return null;
    }
  }
}
