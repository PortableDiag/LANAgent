import { AsyncLocalStorage } from 'node:async_hooks';
import { BasePlugin } from '../core/basePlugin.js';
import { getTextX } from '../../services/textx/index.js';
import { textxRequest, untrusted, formatMessage } from '../../services/textx/textxHub.js';

/**
 * Texting through the user's phone, via the TextX SMS app (docs/TEXTX.md).
 *
 * Every action is a tool the phone runs, and only if the user turned that tool on for this
 * agent in TextX. Reads reach only conversations the user shared with the agent; one-time
 * codes and private conversations never leave the phone; every send is confirmed by the
 * user's tap on the phone. SMS text that comes back is someone else's words: it is returned
 * wrapped as untrusted data, never as instructions.
 */

const ERROR_TEXT = {
  not_allowed: 'TextX has not allowed that on the phone. Turn it on in TextX: Settings › Assistants › this agent.',
  timeout: "The phone didn't answer. It may be offline; TextX picks up queued requests within about 15 minutes.",
  expired: 'The request expired before the phone saw it. Ask again.',
  rate_limited: 'The phone is rate-limiting this agent. Try again in a minute.',
  duplicate: 'That exact request is already waiting for you on the phone.'
};

function errorResult(r) {
  const code = r?.error?.code || 'internal';
  return { success: false, error: ERROR_TEXT[code] || r?.error?.message || code };
}

// The first phone tool each action needs: whether that phone is connected decides if the
// request can be answered in this turn.
const FIRST_TOOL = {
  send: 'send_sms', schedule: 'schedule_message', threads: 'list_threads', read: 'list_threads',
  search: 'search_messages', contact: 'contacts_lookup', watch: 'list_threads', scheduled: 'list_scheduled',
  manageScheduled: 'list_scheduled', react: 'list_threads', markRead: 'list_threads', block: 'block_number'
};
// Set while a request runs in the background for a phone with no socket (see execute()).
const offlineRun = new AsyncLocalStorage();

const numberish = (s) => /^\+?[\d\s().-]{5,}$/.test(String(s).trim());
// A recipient or a message that points back into the conversation instead of saying it.
const PRONOUN = /^(him|her|them|they|he|she|this person|that person|the same person)$/i;
const BACK_REFERENCE = /^(the )?(same|that|it|this)( same)?( thing| message| text| one| email| note)?( again| too)?$/i;

export default class TextXPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'textx';
    this.version = '1.0.0';
    this.description = "Text people from the user's own phone number through the TextX SMS app: send or schedule texts (the user confirms each on the phone), read and search conversations the user shared, look up contacts, and watch a conversation for replies";
    this.timeout = 150000;
    this.commands = [
      {
        command: 'send',
        description: "Send an SMS from the user's phone. The phone shows the text and the user taps Send; nothing goes out without that tap",
        usage: 'send({ to: "Mom", text: "Running 10 minutes late" })',
        examples: ['text mom that I am running late', 'send a text to 555-0100 saying I am outside', 'reply to Sam by SMS: sounds good', 'text the plumber that tomorrow works']
      },
      {
        command: 'schedule',
        description: 'Schedule an SMS for later (the user confirms on the phone). `at` is an ISO-8601 time; repeat is optional {every:"day"|"weekdays"|"week"|"month"|"year"}',
        usage: 'schedule({ to: "Dad", text: "Happy birthday!", at: "2026-11-02T09:00:00-05:00" })',
        examples: ['schedule a text to dad for tomorrow at 9 saying happy birthday', 'text Alex every friday at 5 to remind them about the game']
      },
      {
        command: 'scheduled',
        description: 'List scheduled texts (in shared conversations, or scheduled by the agent)',
        usage: 'scheduled()',
        examples: ['what texts are scheduled', 'show my scheduled messages']
      },
      {
        command: 'manageScheduled',
        description: 'Change a scheduled text: op is cancel, skip_next, send_now or update (with text and/or at). Identify it by its id or by words from its text or recipient',
        usage: 'manageScheduled({ op: "cancel", match: "birthday" })',
        examples: ['cancel the birthday text', 'skip the next friday reminder', 'send the scheduled text to Dad now', 'move the reminder to 6pm']
      },
      {
        command: 'react',
        description: 'React to the latest message (or one matching some words) in a shared conversation with an emoji tapback; the user confirms on the phone',
        usage: 'react({ thread: "Sam", emoji: "👍", match: "see you at 5" })',
        examples: ['thumbs up the last text from Sam', 'heart mom\'s photo']
      },
      {
        command: 'markRead',
        description: 'Mark a shared conversation as read',
        usage: 'markRead({ thread: "Family" })',
        examples: ['mark the family chat as read']
      },
      {
        command: 'block',
        description: 'Block (or unblock) a phone number on the phone; the user confirms',
        usage: 'block({ number: "+15550100", unblock: false })',
        examples: ['block 555-0100', 'unblock that number']
      },
      {
        command: 'threads',
        description: 'List the SMS conversations the user shared with the agent',
        usage: 'threads({ unreadOnly: true })',
        examples: ['what texts do I have', 'any unread texts', 'show my shared conversations']
      },
      {
        command: 'read',
        description: 'Read recent messages in a shared SMS conversation, by its name or id',
        usage: 'read({ thread: "Family", limit: 20 })',
        examples: ['read my texts with Sam', 'what did mom text me', 'catch me up on the family group chat']
      },
      {
        command: 'search',
        description: 'Search the shared SMS conversations',
        usage: 'search({ query: "address", thread: "Sam" })',
        examples: ['find the text where Sam sent the address', 'search my texts for the gate code']
      },
      {
        command: 'contact',
        description: "Look up a contact's phone numbers on the user's phone",
        usage: 'contact({ query: "Sam" })',
        examples: ["what is Sam's number", 'look up the plumber in my contacts']
      },
      {
        command: 'watch',
        description: 'Watch a shared SMS conversation and tell the user when something relevant arrives (up to 7 days)',
        usage: 'watch({ thread: "Sam", purpose: "the delivery time", hours: 24 })',
        examples: ['let me know when Sam replies', 'tell me if the landlord texts back about the lease', 'watch the family chat for dinner plans']
      },
      {
        command: 'unwatch',
        description: 'Stop watching a conversation',
        usage: 'unwatch({ thread: "Sam" })',
        examples: ['stop watching my texts with Sam']
      },
      {
        command: 'status',
        description: 'Which phones are paired with the agent through TextX, and what they allow',
        usage: 'status()',
        examples: ['is my phone connected to textx', 'textx status']
      }
    ];
  }

  get svc() { return getTextX(this.agent); }

  /** The phone this request came from, if it came from TextX. */
  origin() { return textxRequest.getStore()?.deviceId || null; }

  async execute(params = {}) {
    const { action, ...data } = params;
    if (data.needsParameterExtraction) await this._extractArgs(action, data);
    // From Telegram or the dashboard, with the phone's TextX closed: the phone only checks in
    // every 15 minutes (protocol §3.2), so a 45 s wait for a contact lookup always failed
    // ("Send Wayne a text", 2026-10-18). Answer now; finish when the phone checks in.
    const tool = FIRST_TOOL[action];
    if (tool && !this.origin()) {
      const device = await this.svc.hub.pickDevice(tool);
      if (device && !this.svc.hub.isConnected(device.id)) {
        offlineRun.run(true, () => this.run(action, data))
          .then(r => this.agent.notify?.(`TextX: ${r.success ? r.result : r.error}`))
          .catch(e => this.logger.error(`textx ${action} (phone offline) failed: ${e.message}`));
        return { success: true, result: `Your phone (${device.name}) isn't connected to me right now, so this waits for TextX to check in, ` +
          'within about 15 minutes (opening TextX does it at once). I\'ll tell you here how it went.' };
      }
    }
    const res = await this.run(action, data);
    if (!res.success) this.logger.warn(`textx ${action}: ${res.error}`);
    return res;
  }

  async run(action, data) {
    try {
      switch (action) {
        case 'send': return await this.send(data);
        case 'schedule': return await this.send(data, true);
        case 'threads': return await this.threads(data);
        case 'read': return await this.read(data);
        case 'search': return await this.search(data);
        case 'contact': return await this.contact(data);
        case 'watch': return await this.watch(data);
        case 'unwatch': return await this.unwatch(data);
        case 'status': return await this.status();
        case 'scheduled': return await this.scheduled();
        case 'manageScheduled': return await this.manageScheduled(data);
        case 'react': return await this.react(data);
        case 'markRead': return await this.markRead(data);
        case 'block': return await this.block(data);
        default: return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (error) {
      this.logger.error(`textx ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async _extractArgs(action, data) {
    const request = String(data.originalInput || data.query || '').trim();
    for (const k of ['needsParameterExtraction', 'originalInput']) delete data[k];
    if (action !== 'search') delete data.query;
    const cmd = this.commands.find(c => c.command === action);
    const pm = this.agent?.providerManager;
    if (!request || !cmd?.usage || !pm?.generateResponse) return;
    try {
      const res = await pm.generateResponse(
        `Extract the arguments for the texting action ${action} from this request.\nCall shape: ${cmd.usage}\n` +
        `Request: ${request}\nUse exactly the argument names in the call shape. Copy the message text exactly as the ` +
        `user wants it sent. Times are ISO-8601 with the offset; now is ${new Date().toISOString()}. Leave out what ` +
        'the request does not say. Answer with one JSON object only.',
        { maxTokens: 600, temperature: 0 });
      const raw = String(res?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
      const got = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      for (const [k, v] of Object.entries(got || {})) {
        if (k === 'action' || k.startsWith('_')) continue;
        if ((data[k] == null || data[k] === '') && v != null && v !== '') data[k] = v;
      }
    } catch (err) {
      this.logger.warn(`textx ${action}: argument extraction failed: ${err.message}`);
    }
  }

  /** A request typed on a paired phone drives tools on that phone only; elsewhere (Telegram, dashboard) on your TextX phone. */
  call(name, args, opts = {}) {
    const origin = this.origin();
    return this.svc.hub.callTool(name, args, { deviceId: origin, onlyDevice: origin, offline: !!offlineRun.getStore(), ...opts });
  }

  /** Names → numbers through the phone's contacts. Returns { numbers } or { error }. */
  async resolveRecipients(to) {
    const list = (Array.isArray(to) ? to : String(to || '').split(/\s*(?:,|;|\band\b)\s*/)).map(s => String(s).trim()).filter(Boolean);
    if (!list.length) return { error: 'Who should the text go to?' };
    const numbers = [];
    for (const who of list) {
      if (numberish(who)) { numbers.push(who.replace(/[^\d+]/g, '')); continue; }
      const r = await this.call('contacts_lookup', { query: who, limit: 5 });
      if (!r.ok) return { error: r.error?.code === 'not_allowed' ? `I need ${who}'s number: contact lookup is off for this agent in TextX.` : errorResult(r).error };
      let hits = (r.result || []).filter(c => (c.numbers || []).length);
      // "Wayne CommanderFog" (a nickname the agent knows) vs "Wayne Williams" in the phone: try
      // each word, and take it only when exactly one contact answers.
      if (!hits.length && /\s/.test(who)) {
        const seen = new Map();
        for (const word of who.split(/\s+/).filter(w => w.length >= 3)) {
          const w = await this.call('contacts_lookup', { query: word, limit: 5 });
          for (const c of (w.ok ? w.result || [] : [])) if ((c.numbers || []).length) seen.set(c.name, c);
        }
        if (seen.size === 1) hits = [...seen.values()];
        else if (seen.size > 1) {
          const options = [...seen.values()].flatMap(c => c.numbers.map(n => `${c.name}: ${n}`)).slice(0, 8).join('\n');
          return { error: `"${who}" could be more than one contact; which one?\n${options}` };
        }
      }
      if (!hits.length) return { error: `No contact matches "${who}".` };
      const exact = hits.filter(c => c.name?.toLowerCase() === who.toLowerCase());
      const pick = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
      if (!pick || pick.numbers.length > 1) {
        const options = hits.flatMap(c => c.numbers.map(n => `${c.name}: ${n}`)).slice(0, 8).join('\n');
        return { error: `"${who}" matches more than one number; which one?\n${options}` };
      }
      numbers.push(pick.numbers[0]);
    }
    return { numbers };
  }

  /**
   * "Send him the same thing": who and what come from the live conversation. Returns
   * { to, text } (either may be unchanged) or { error } asking the user, never a guess.
   */
  async fromConversation(data, to, text) {
    if (!PRONOUN.test(String(to || '').trim()) && !BACK_REFERENCE.test(String(text || '').trim())) return { to, text };
    const uid = data._context?.userId || (this.origin() ? `textx:${this.origin()}` : null);
    const turns = uid ? (this.agent.memoryManager?.getRecentTurns?.(uid, data._context?.threadId, 8) || []) : [];
    if (!turns.length) return { error: "Who should it go to, and what should it say? I don't have the earlier conversation to go on." };
    const said = String(data._context?.originalInput || '');
    let got = {};
    try {
      const res = await this.agent.providerManager.generateResponse(
        'Conversation so far (oldest first):\n' + turns.map(t => `${t.role}: ${t.content}`).join('\n') +
        `\n\nThe user now says: "${said}"\n` +
        'They want a text message sent. Work out from the conversation who it goes to (a name or number exactly as it ' +
        'appears) and the exact message text. If they mean an earlier message ("the same thing"), copy that message body ' +
        'word for word: the body only, no subject line, no email headers, no JSON. Answer one JSON object ' +
        '{"to": string|null, "text": string|null}, null for anything the conversation does not settle.',
        { maxTokens: 800, temperature: 0 });
      const raw = String(res?.content || '');
      got = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) || {};
    } catch (err) {
      this.logger.warn(`textx: could not resolve the reference from the conversation: ${err.message}`);
    }
    const newTo = PRONOUN.test(String(to || '').trim()) ? got.to : to;
    const newText = BACK_REFERENCE.test(String(text || '').trim()) ? got.text : text;
    if (!newTo || PRONOUN.test(String(newTo))) return { error: 'Who should I text? Give me their name or number.' };
    if (!newText || BACK_REFERENCE.test(String(newText))) return { error: 'What should the text say?' };
    return { to: newTo, text: String(newText).trim() };
  }

  async send(data, scheduled = false) {
    const ref = await this.fromConversation(data, data.to || data.recipient || data.contact, String(data.text || data.message || '').trim());
    if (ref.error) return { success: false, error: ref.error };
    data = { ...data, to: ref.to };
    const text = String(ref.text || '').trim();
    if (!text) return { success: false, error: 'What should the text say?' };
    if (scheduled && !Number.isFinite(Date.parse(data.at))) return { success: false, error: 'When should it be sent? Give a date and time.' };
    // A named conversation (a group) is addressed by its thread; people by their numbers.
    let target;
    if (data.thread && !data.to) {
      const f = await this.findThread(data.thread);
      if (f.error) return { success: false, error: f.error };
      target = { thread_id: f.thread.thread_id };
    } else {
      const rcpt = await this.resolveRecipients(data.to || data.recipient || data.contact);
      if (rcpt.error) return { success: false, error: rcpt.error };
      target = { to: rcpt.numbers };
    }

    const originId = this.origin();
    const attachments = this.fileAttachment(data._context?.attachedFile);
    const args = scheduled
      ? { ...target, text, at: new Date(data.at).toISOString(), ...(data.repeat ? { repeat: data.repeat } : {}), ...(data.interval ? { interval: data.interval } : {}), ...(data.endAfter ? { end_after: data.endAfter } : {}), ...(attachments ? { attachments } : {}) }
      : { ...target, text, ...(attachments ? { attachments } : {}) };
    const tool = scheduled ? 'schedule_message' : 'send_sms';
    const r = await this.call(tool, args, { onLate: (late) => this.reportLate(originId, late, scheduled) });
    if (!r.ok) return errorResult(r);
    if (r.pending) {
      return { success: true, result: `It's on your phone (${r.device}) for you to confirm. Tap Send there; I'll tell you when it's done.` };
    }
    return { success: true, result: this.outcomeText(r.result, scheduled) };
  }

  outcomeText(res, scheduled) {
    const status = res?.status;
    if (status === 'sent') return 'Sent.';
    if (status === 'scheduled' || (scheduled && status === 'confirmed')) return `Scheduled${res?.next_at ? ` for ${res.next_at}` : ''}.`;
    if (['updated', 'cancelled', 'retrying', 'deleted', 'blocked', 'unblocked', 'read'].includes(status)) return `Done: ${status}.`;
    if (status === 'skipping_next') return 'The next one will be skipped.';
    if (status === 'will_send') return 'The next one will be sent after all.';
    if (status === 'declined') return 'You declined it on the phone, so nothing was sent.';
    if (status === 'timeout') return 'Nobody confirmed it on the phone within 5 minutes, so nothing was sent.';
    return `The phone answered: ${status || 'done'}.`;
  }

  async reportLate(originId, late, scheduled) {
    const text = late.ok ? this.outcomeText(late.result, scheduled) : errorResult(late).error;
    const hub = this.svc.hub;
    const device = originId ? await hub.store.getDevice(originId) : null;
    if (device) await hub.deliver(device, 'message', { text });
    else await this.agent.notify?.(`Text message: ${text}`);
  }

  async findThread(thread) {
    const r = await this.call('list_threads', { limit: 50 });
    if (!r.ok) return { error: errorResult(r).error };
    const all = r.result || [];
    if (!thread) return { error: 'Which conversation?' };
    const q = String(thread).toLowerCase();
    const hit = all.find(t => String(t.thread_id) === String(thread)) ||
      all.find(t => (t.title || '').toLowerCase() === q) ||
      all.find(t => (t.title || '').toLowerCase().includes(q) ||
        (t.participants || []).some(p => (p.name || '').toLowerCase().includes(q) || (p.number || '').includes(q)));
    if (!hit) {
      const names = all.map(t => t.title).filter(Boolean).slice(0, 10).join(', ');
      return { error: `"${thread}" isn't one of the conversations shared with me${names ? ` (shared: ${names})` : ''}. Share it in TextX: the conversation › Details › Share with this agent.` };
    }
    return { thread: hit };
  }

  async threads(data) {
    const r = await this.call('list_threads', { limit: Math.min(Number(data.limit) || 20, 50), ...(data.unreadOnly ? { unread_only: true } : {}) });
    if (!r.ok) return errorResult(r);
    const list = r.result || [];
    if (!list.length) return { success: true, result: 'No conversations are shared with me in TextX.' };
    const lines = list.map(t => `- ${t.title || (t.participants || []).map(p => p.name || p.number).join(', ')}${t.unread ? ` (${t.unread} unread)` : ''} — last ${t.last_date || '?'}`);
    return { success: true, result: `Shared conversations:\n${lines.join('\n')}` };
  }

  async read(data) {
    const f = await this.findThread(data.thread || data.contact || data.query);
    if (f.error) return { success: false, error: f.error };
    const r = await this.call('read_thread', { thread_id: f.thread.thread_id, limit: Math.min(Number(data.limit) || 20, 100) });
    if (!r.ok) return errorResult(r);
    const msgs = (r.result || []).map(formatMessage).join('\n');
    return { success: true, result: `Conversation "${f.thread.title}":\n${untrusted('SMS', msgs || '(no messages)')}` };
  }

  async search(data) {
    const query = String(data.query || '').trim();
    if (!query) return { success: false, error: 'What should I search for?' };
    const args = { query, limit: Math.min(Number(data.limit) || 20, 50) };
    if (data.thread) {
      const f = await this.findThread(data.thread);
      if (f.error) return { success: false, error: f.error };
      args.thread_id = f.thread.thread_id;
    }
    const r = await this.call('search_messages', args);
    if (!r.ok) return errorResult(r);
    const msgs = (r.result || []).map(formatMessage).join('\n');
    return { success: true, result: msgs ? `Matches for "${query}":\n${untrusted('SMS', msgs)}` : `Nothing in the shared conversations matches "${query}".` };
  }

  async contact(data) {
    const query = String(data.query || data.name || '').trim();
    if (!query) return { success: false, error: 'Who should I look up?' };
    const r = await this.call('contacts_lookup', { query, limit: 10 });
    if (!r.ok) return errorResult(r);
    const list = (r.result || []).map(c => `- ${c.name}: ${(c.numbers || []).join(', ')}`);
    return { success: true, result: list.length ? list.join('\n') : `No contact matches "${query}".` };
  }

  async watch(data) {
    const f = await this.findThread(data.thread || data.contact);
    if (f.error) return { success: false, error: f.error };
    const hours = Math.min(Math.max(Number(data.hours) || 24, 1), 168);
    const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    const r = await this.call('watch', { thread_id: f.thread.thread_id, until });
    if (!r.ok) return errorResult(r);
    const hub = this.svc.hub;
    const device = await hub.pickDevice('watch', this.origin());
    await hub.addWatch(device, {
      watchId: r.result?.watch_id, threadId: f.thread.thread_id, title: f.thread.title,
      purpose: String(data.purpose || '').slice(0, 300), origin: this.origin() ? 'textx' : 'other', until
    });
    return { success: true, result: `Watching "${f.thread.title}" for ${hours} hours${data.purpose ? ` for ${data.purpose}` : ''}.` };
  }

  async unwatch(data) {
    const hub = this.svc.hub;
    const q = String(data.thread || data.contact || '').toLowerCase();
    for (const d of await hub.store.listDevices()) {
      const hit = (d.watches || []).filter(w => !q || (w.title || '').toLowerCase().includes(q) || String(w.threadId) === q);
      if (!hit.length) continue;
      for (const w of hit) await hub.callTool('unwatch', { watch_id: w.watchId }, { deviceId: d.id });
      await hub.store.updateDevice(d.id, { watches: (d.watches || []).filter(w => !hit.includes(w)) });
      return { success: true, result: `Stopped watching ${hit.map(w => `"${w.title}"`).join(', ')}.` };
    }
    return { success: false, error: q ? `I'm not watching "${data.thread}".` : "I'm not watching any conversation." };
  }

  /** A file the user gave the agent (Telegram, dashboard) goes out as MMS, within the 5 MB cap. */
  fileAttachment(file) {
    if (!file?.base64) return null;
    if (Buffer.byteLength(file.base64, 'base64') > 5 * 1024 * 1024) return null;
    return [{ name: file.filename || 'attachment', mime: file.mimeType || 'application/octet-stream', data_b64: file.base64 }];
  }

  /** A confirmed tool: answers now if tapped quickly, else reports the outcome when it comes. */
  async confirmed(tool, args) {
    const originId = this.origin();
    const r = await this.call(tool, args, { onLate: (late) => this.reportLate(originId, late, false) });
    if (!r.ok) return errorResult(r);
    if (r.pending) return { success: true, result: `It's on your phone (${r.device}) for you to confirm; I'll tell you when it's done.` };
    return { success: true, result: this.outcomeText(r.result, false) };
  }

  async listScheduled() {
    const r = await this.call('list_scheduled', {});
    return r.ok ? { list: r.result || [] } : { error: errorResult(r).error };
  }

  async scheduled() {
    const { list, error } = await this.listScheduled();
    if (error) return { success: false, error };
    if (!list.length) return { success: true, result: 'Nothing is scheduled.' };
    const lines = list.map(x => `- ${x.next_at}${x.repeat && x.repeat !== 'none' ? ` (${x.repeat})` : ''} to ${(x.to || []).join(', ') || x.thread_id}: ${x.text}${x.skip_next ? ' [next one skipped]' : ''} (id ${x.schedule_id})`);
    return { success: true, result: `Scheduled texts:\n${untrusted('SCHEDULED', lines.join('\n'))}` };
  }

  async manageScheduled(data) {
    const op = String(data.op || '').toLowerCase().replace(/[\s-]+/g, '_');
    const { list, error } = await this.listScheduled();
    if (error) return { success: false, error };
    const q = String(data.id || data.schedule_id || data.match || '').toLowerCase();
    const hits = list.filter(x => String(x.schedule_id) === q || (q && ((x.text || '').toLowerCase().includes(q) || (x.to || []).some(n => n.includes(q)))));
    const pick = hits.length === 1 ? hits[0] : (list.length === 1 && !q ? list[0] : null);
    if (!pick) {
      return { success: false, error: hits.length > 1 ? `More than one scheduled text matches "${q}"; which one?` : 'Which scheduled text? Say part of its text or its id.' };
    }
    const id = pick.schedule_id;
    if (op === 'cancel') {
      const r = await this.call('cancel_scheduled', { schedule_id: id });
      return r.ok ? { success: true, result: 'Cancelled; it will not be sent.' } : errorResult(r);
    }
    if (op === 'skip_next' || op === 'skip') {
      const r = await this.call('skip_next', { schedule_id: id });
      return r.ok ? { success: true, result: this.outcomeText(r.result, false) } : errorResult(r);
    }
    if (op === 'send_now') return this.confirmed('send_scheduled_now', { schedule_id: id });
    if (op === 'update') {
      const args = { schedule_id: id };
      if (data.text) args.text = String(data.text);
      if (data.at && Number.isFinite(Date.parse(data.at))) args.at = new Date(data.at).toISOString();
      if (!args.text && !args.at) return { success: false, error: 'What should change: the text, or the time?' };
      return this.confirmed('update_scheduled', args);
    }
    return { success: false, error: 'Use op cancel, skip_next, send_now or update.' };
  }

  async react(data) {
    const emoji = String(data.emoji || '').trim();
    if (!emoji) return { success: false, error: 'Which reaction?' };
    const f = await this.findThread(data.thread || data.contact);
    if (f.error) return { success: false, error: f.error };
    const r = await this.call('read_thread', { thread_id: f.thread.thread_id, limit: 30 });
    if (!r.ok) return errorResult(r);
    const msgs = (r.result || []).filter(m => m.direction !== 'out' && m.from !== 'me');
    const q = String(data.match || '').toLowerCase();
    const target = q ? msgs.filter(m => (m.text || '').toLowerCase().includes(q)).pop() : msgs[msgs.length - 1];
    if (!target) return { success: false, error: q ? `No message there matches "${data.match}".` : 'There is no message from them to react to.' };
    return this.confirmed('react', { thread_id: f.thread.thread_id, message_id: target.message_id, emoji, ...(data.remove ? { remove: true } : {}) });
  }

  async markRead(data) {
    const f = await this.findThread(data.thread || data.contact);
    if (f.error) return { success: false, error: f.error };
    const r = await this.call('mark_read', { thread_id: f.thread.thread_id });
    return r.ok ? { success: true, result: `Marked "${f.thread.title}" as read.` } : errorResult(r);
  }

  async block(data) {
    // Only when the user actually said block: a weak intent match once turned "text <number> …"
    // into a block request (the phone's confirmation caught it).
    const said = String(data._context?.originalInput ?? data.originalInput ?? '');
    if (said && !/\b(un)?block/i.test(said)) {
      return { success: false, error: "That didn't sound like a request to block a number, so I didn't. Say \"block <number>\" if you meant to." };
    }
    const number = String(data.number || data.to || '').replace(/[^\d+]/g, '');
    if (number.length < 5) return { success: false, error: 'Which number?' };
    return this.confirmed('block_number', { number, ...(data.unblock ? { unblock: true } : {}) });
  }

  async status() {
    const s = await this.svc.status();
    if (!s.devices.length) {
      return { success: true, result: 'No phone is paired. Pair one from the dashboard: Settings › TextX › Pair a phone, then scan the QR in TextX.' };
    }
    const lines = s.devices.map(d => `- ${d.name}: ${d.connected ? 'connected' : d.bound ? `last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : 'never'}` : 'not scanned yet'}; allows ${d.tools.length ? d.tools.join(', ') : 'chat only'}`);
    const relay = s.relay.enabled === false ? 'relay off' : s.relay.connected ? `relay up (${s.relay.base})` : 'relay connecting';
    return { success: true, result: `TextX (${relay}):\n${lines.join('\n')}` };
  }
}
