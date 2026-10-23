import { BasePlugin } from '../core/basePlugin.js';
import { nowInZone, resolveRequestTime, localZone } from '../../utils/wallClock.js';
import { getTextX } from '../../services/textx/index.js';
import { textxRequest } from '../../services/textx/textxHub.js';
import { isoWithOffset, getDialXSettings, agentAudio, clock } from '../../services/textx/dialx.js';

/**
 * Phone calls through the DialX dialer app ("call Wayne and tell him happy birthday at 5pm").
 * DialX pairs like TextX (dashboard → Settings → TextX → Pair) and owns every limit: only
 * contacts the owner approved in DialX for this agent, one confirm card per call, a fixed AI
 * disclosure first, 08:00–21:00 owner time, 3 calls an hour and 10 a day, 5 minutes a call.
 * This plugin asks for the call; the conversation itself runs in the hub (services/textx/dialx.js).
 */

const ERROR_TEXT = {
  not_allowed: 'DialX has not allowed that for this agent. Turn it on in DialX: this agent › tools.',
  not_supported: 'DialX says this agent does not support calls yet.',
  outside_hours: null, // DialX's own message names the hours and zone
  rate_limited: 'DialX is rate-limiting calls from this agent (3 an hour, 10 a day). Try later.',
  busy_in_call: 'DialX is on a call right now. Try again when it ends.',
  timeout: "DialX didn't answer. The phone may be offline.",
  expired: 'The request expired before DialX saw it. Ask again.',
  not_owner: 'DialX only takes calls you ask for yourself.',
  not_approved: "That contact isn't approved for me in DialX. Add them in DialX first.",
  forbidden_number: "DialX won't let me call that number (emergency, short-code, premium or international numbers are never allowed).",
  in_the_past: 'That time has already passed. When should I call?',
  too_far_ahead: 'DialX schedules calls at most 30 days ahead.',
  duplicate: 'That exact call is already waiting for you to approve on the phone.'
};

function errorResult(r) {
  const code = r?.error?.code || 'internal';
  return { success: false, error: ERROR_TEXT[code] || r?.error?.message || code };
}

/** A contact from DialX's approved list, whatever it calls its fields. */
function contactOf(c) {
  return { id: c.contact_id ?? c.id ?? null, name: String(c.name || c.display_name || '').trim(),
    number: c.number || (Array.isArray(c.numbers) ? c.numbers[0] : '') || '' };
}

function listOf(result, ...keys) {
  if (Array.isArray(result)) return result;
  for (const k of keys) if (Array.isArray(result?.[k])) return result[k];
  return [];
}

function when(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) : String(iso || '');
}

export default class DialXPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'dialx';
    this.version = '1.0.0';
    this.description = "Place phone calls from the user's own phone through the DialX dialer app: the agent calls an approved contact at a time and talks with them in its own voice (the user approves each call on the phone), and lists or cancels scheduled calls";
    this.timeout = 120000;
    this.commands = [
      {
        command: 'call',
        description: 'Phone someone from the user\'s phone and talk with them. `purpose` is why the user wants the call; `opening` is the first thing to say to them; `at` is when (ISO-8601, omit for now). Only contacts approved in DialX; the user confirms on the phone',
        usage: 'call({ contact: "Wayne", at: "2026-10-23T17:00", purpose: "wish him a happy birthday", opening: "Hi Wayne! I\'m calling to wish you a happy birthday." })',
        examples: ['call wayne and tell him happy birthday at 5pm', 'phone mom and ask if she needs anything from the store', 'give the plumber a call tomorrow at 9 and confirm the appointment', 'ring Sam now and let him know I\'m running late']
      },
      {
        command: 'calls',
        description: 'List the calls scheduled in DialX',
        usage: 'calls()',
        examples: ['what calls are scheduled', 'show my scheduled calls']
      },
      {
        command: 'cancel',
        description: 'Cancel a scheduled call, by its id or the contact\'s name',
        usage: 'cancel({ contact: "Wayne" })',
        examples: ['cancel the call to wayne', 'don\'t call mom after all']
      },
      {
        command: 'contacts',
        description: 'Who the agent is allowed to call (the approved list in DialX)',
        usage: 'contacts()',
        examples: ['who can you call', 'which contacts are approved for calls']
      },
      {
        command: 'voicemails',
        description: 'List voicemails from DialX, with what each caller said (unreadOnly for new ones)',
        usage: 'voicemails({ unreadOnly: true })',
        examples: ['any new voicemails', 'do I have voicemail', 'list my voicemails']
      },
      {
        command: 'voicemail',
        description: 'Read one voicemail (the latest, or the one from a caller), optionally with its audio recording',
        usage: 'voicemail({ from: "Wayne", audio: false })',
        examples: ['read my latest voicemail', 'what did wayne say in his voicemail', 'send me the voicemail from mom', 'play the last voicemail']
      },
      {
        command: 'markVoicemail',
        description: 'Mark a voicemail read or unread, by caller or id',
        usage: 'markVoicemail({ from: "Wayne", read: true })',
        examples: ['mark wayne\'s voicemail as read', 'mark all voicemails read']
      },
      {
        command: 'deleteVoicemail',
        description: 'Delete a voicemail, by caller or id (the user confirms on the phone)',
        usage: 'deleteVoicemail({ from: "spam caller" })',
        examples: ['delete the voicemail from that spam number', 'delete wayne\'s voicemail']
      },
      {
        command: 'recents',
        description: 'Recent calls on the phone, from DialX',
        usage: 'recents()',
        examples: ['who called me today', 'show my recent calls']
      },
      {
        command: 'screened',
        description: 'Calls DialX screened (spam or unknown callers)',
        usage: 'screened()',
        examples: ['what calls were screened', 'any spam calls today']
      }
    ];
  }

  get hub() { return getTextX(this.agent).hub; }
  settings() { return getDialXSettings(); }
  /** A DialX phone is paired: until then "call Wayne" is not read as a phone call. */
  get paired() { try { return !!this.hub?.dialxPaired; } catch { return false; } }

  async execute(params = {}) {
    const { action, ...data } = params;
    try {
      switch (action) {
        case 'call': return await this.call(data);
        case 'calls': return await this.listing('dialx.list_scheduled_calls', 'scheduled calls', ['calls', 'scheduled']);
        case 'cancel': return await this.cancel(data);
        case 'contacts': return await this.listing('dialx.list_approved_contacts', 'approved contacts', ['contacts']);
        case 'recents': return await this.listing('dialx.list_recents', 'recent calls', ['calls', 'recents']);
        case 'screened': return await this.listing('dialx.list_screened', 'screened calls', ['calls', 'screened']);
        case 'voicemails': return await this.voicemails(data);
        case 'voicemail': return await this.voicemail(data);
        case 'markVoicemail': return await this.markVoicemail(data);
        case 'deleteVoicemail': return await this.deleteVoicemail(data);
        default: return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (error) {
      this.logger.error(`dialx ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /** The DialX phone a tool goes to. */
  async device(tool) {
    const d = await this.hub.pickDevice(tool);
    return d || null;
  }

  async tool(name, args = {}, opts = {}) {
    const d = await this.device(name);
    if (!d) return { ok: false, error: { code: 'none', message: `No DialX phone allows ${name.replace('dialx.', '')} for this agent. Pair DialX (Settings → TextX → Pair a phone, then scan in DialX) and turn the tool on in DialX.` } };
    return this.hub.callTool(name, args, { deviceId: d.id, onlyDevice: d.id, ...opts });
  }

  /** Only the owner orders calls: a TextX phone of theirs, Telegram as them, or the dashboard. */
  fromOwner(data) {
    const uid = data._context?.userId;
    return !!textxRequest.getStore()?.deviceId || !uid || String(uid) === String(process.env.TELEGRAM_USER_ID || '');
  }

  async call(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can ask me to place calls.' };
    const request = String(data._context?.originalInput || data.originalInput || '');
    if (data.needsParameterExtraction || !data.contact || !data.opening) await this.extract(data, request);
    const who = String(data.contact || data.to || data.name || '').trim();
    if (!who) return { success: false, error: 'Who should I call?' };
    const purpose = String(data.purpose || data.message || '').trim();
    const opening = String(data.opening || '').trim();
    if (!purpose && !opening) return { success: false, error: `What should I say to ${who}?` };

    const list = await this.tool('dialx.list_approved_contacts');
    if (!list.ok) return errorResult(list);
    const approved = listOf(list.result, 'contacts').map(contactOf).filter(c => c.name || c.number);
    const pick = this.match(approved, who);
    if (pick.error) return { success: false, error: pick.error };

    // No time = now: `at` is left out (DialX's "omitted: now"), so a few seconds in transit
    // can never turn "call him now" into an in_the_past refusal.
    let at = null;
    if (data.at) {
      const d = resolveRequestTime(data.at, request);
      if (!d) return { success: false, error: `I couldn't read the time "${data.at}". When should I call?` };
      at = d;
    }
    const device = await this.device('dialx.schedule_call');
    const settings = await this.settings();
    const line = opening || `Hi ${pick.contact.name || 'there'}! I'm calling about ${purpose}.`;
    const audio = await agentAudio(this.agent, device, line, settings, this.logger);
    const args = {
      ...(pick.contact.id != null ? { contact_id: pick.contact.id } : { number: pick.contact.number }),
      ...(at ? { at: isoWithOffset(at, localZone()) } : {}),
      purpose: purpose || line,
      opening: line,
      ...(audio ? { opening_audio_b64: audio.audio_b64 } : {}),
      requested_by_owner: true
    };
    const name = pick.contact.name || who;
    const r = await this.tool('dialx.schedule_call', args, {
      onLate: (late) => this.agent.notify?.(late.ok ? `📞 ${this.outcome(late.result, name, args.at, line)}` : `⚠️ Call to ${name}: ${errorResult(late).error}`)
    });
    if (!r.ok) return errorResult(r);
    if (r.pending) return { success: true, result: `It's on your phone for you to approve: calling ${name} at ${when(args.at)} (${purpose || line}). Tap Approve in DialX; I'll tell you when it's set.` };
    return { success: true, result: this.outcome(r.result, name, args.at, line) };
  }

  /** schedule_call's result: {status: "scheduled", call_id, at} | {status: "declined"} | {status: "timeout"} (DialX 0.2.0). */
  outcome(result, name, at, line) {
    const status = String(result?.status || 'scheduled');
    if (status === 'declined') return `You declined the call to ${name} on the phone, so it won't happen.`;
    if (status === 'timeout') return `The call to ${name} wasn't approved on the phone in time, so it isn't scheduled. Ask again to retry.`;
    if (status === 'scheduled') return `Call to ${name} scheduled for ${when(result?.at || at)}: I'll open with "${line}" and tell you how it went.`;
    return `Call to ${name}: DialX answered "${status}".`;
  }

  /** One approved contact for the name, or an error that lists the choices. */
  match(approved, who) {
    if (!approved.length) return { error: 'No contacts are approved for me in DialX yet. Add them in DialX: this agent › approved contacts.' };
    const q = who.toLowerCase();
    const digits = who.replace(/\D/g, '');
    const exact = approved.filter(c => c.name.toLowerCase() === q || (digits.length >= 7 && c.number.replace(/\D/g, '').endsWith(digits)));
    const hits = exact.length ? exact : approved.filter(c => c.name.toLowerCase().split(/\s+/).includes(q) || c.name.toLowerCase().includes(q));
    if (hits.length === 1) return { contact: hits[0] };
    const names = approved.map(c => c.name || c.number).slice(0, 12).join(', ');
    if (!hits.length) return { error: `${who} isn't on my approved list in DialX (approved: ${names}). Add them in DialX first.` };
    return { error: `"${who}" matches more than one approved contact: ${hits.map(c => c.name).join(', ')}. Which one?` };
  }

  async extract(data, request) {
    const pm = this.agent?.providerManager;
    if (!request || !pm?.generateResponse) return;
    const owner = process.env.OWNER_NAME || 'the user';
    const name = this.agent?.config?.name || process.env.AGENT_NAME || 'the assistant';
    try {
      const res = await pm.generateResponse(
        `${owner} asked you, ${name}, to make a phone call. Request: ${request}\n` +
        'Extract one JSON object {"contact": who to call, "at": when, "purpose": why, "opening": first line}.\n' +
        '- "at": the wall-clock time they said, YYYY-MM-DDTHH:mm with no offset or Z (a time with no date that has ' +
        `already passed today means tomorrow); null for now. Local now is ${nowInZone()}.\n` +
        `- "purpose": what ${owner} wants from the call, in a few words ("wish Wayne a happy birthday").\n` +
        `- "opening": the first thing you will say to them, after the phone has already said you are ${owner}'s AI ` +
        `assistant: one or two warm, spoken sentences addressed to them, carrying ${owner}'s message ("Hi Wayne! ` +
        `${owner} asked me to call and wish you a very happy birthday."). No emoji or symbols.\n` +
        'Leave out what the request does not say. Answer the JSON only.',
        { maxTokens: 300, temperature: 0.3 });
      const raw = String(res?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
      const got = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) || {};
      for (const k of ['contact', 'at', 'purpose', 'opening']) {
        if ((data[k] == null || data[k] === '') && got[k] != null && got[k] !== '') data[k] = got[k];
      }
    } catch (err) {
      this.logger.warn(`dialx call: argument extraction failed: ${err.message}`);
    }
    delete data.needsParameterExtraction;
  }

  // ── voicemail (DialX 0.3.0) ─────────────────────────────────────────────────────────────
  // A transcript is the caller's words: it is shown to the owner, never followed.

  async listVoicemails(unreadOnly = false) {
    const r = await this.tool('dialx.list_voicemails', { limit: 50, ...(unreadOnly ? { unread_only: true } : {}) });
    if (!r.ok) return { error: r.error?.code === 'not_allowed' || r.error?.code === 'none'
      ? 'Voicemail is off for me in DialX. Turn on "Read voicemail" for this agent in DialX.' : errorResult(r).error };
    return { list: listOf(r.result, 'voicemails') };
  }

  vmLine(v) {
    const who = v.name || v.number || 'unknown number';
    const words = String(v.transcript || '').trim();
    return `${v.read ? '' : '🆕 '}${who} (${when(v.at)}, ${clock(v.duration_s)}): ${words ? `"${words.slice(0, 400)}"` : '(no transcript)'}`;
  }

  /** The voicemail meant: by id, by caller, or the latest. */
  async findVoicemail(data) {
    const got = await this.listVoicemails();
    if (got.error) return got;
    const id = data.voicemail_id || data.id;
    const from = String(data.from || data.caller || data.name || data.contact || '').toLowerCase().trim();
    const list = [...got.list].sort((a, b) => new Date(b.at) - new Date(a.at));
    const hits = id ? list.filter(v => String(v.voicemail_id) === String(id))
      : from && !/^(the )?(latest|last|newest|most recent)$/.test(from)
        ? list.filter(v => `${v.name || ''} ${v.number || ''}`.toLowerCase().includes(from) || String(v.number || '').replace(/\D/g, '').endsWith(from.replace(/\D/g, '') || '#'))
        : list.slice(0, 1);
    if (!hits.length) return { error: from ? `No voicemail from ${from}.` : 'No voicemails.' };
    return { vm: hits[0], more: hits.length - 1 };
  }

  async voicemails(data) {
    const got = await this.listVoicemails(!!(data.unreadOnly || data.unread_only));
    if (got.error) return { success: false, error: got.error };
    if (!got.list.length) return { success: true, result: data.unreadOnly || data.unread_only ? 'No new voicemails.' : 'No voicemails.' };
    return { success: true, result: `Voicemails:\n${got.list.slice(0, 20).map(v => `- ${this.vmLine(v)}`).join('\n')}`, data: got.list };
  }

  async voicemail(data) {
    const f = await this.findVoicemail(data);
    if (f.error) return { success: false, error: f.error };
    const text = this.vmLine(f.vm) + (f.more ? `\n(${f.more} more from them; ask for the list to see all.)` : '');
    const request = String(data._context?.originalInput || '');
    const wantsAudio = data.audio === true || /\b(play|send|audio|recording|listen|hear)\b/i.test(request);
    if (!wantsAudio) return { success: true, result: text };
    const a = await this.tool('dialx.get_voicemail_audio', { voicemail_id: f.vm.voicemail_id });
    if (!a.ok || !a.result?.audio_b64) {
      const off = a.error?.code === 'not_allowed';
      return { success: true, result: `${text}\n\n${off ? 'The recording is off for me: turn on "Listen to voicemail audio" in DialX.' : `I couldn't get the recording: ${errorResult(a).error}`}` };
    }
    const audio = Buffer.from(a.result.audio_b64, 'base64');
    const ext = audio.subarray(0, 4).toString('latin1') === 'RIFF' ? 'wav' : audio.subarray(0, 3).toString('latin1') === 'ID3' || audio[0] === 0xff ? 'mp3' : 'amr';
    return { success: true, result: text, audio, format: 'buffer', mimetype: ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'audio/amr',
      filename: `voicemail-${String(f.vm.name || f.vm.number || 'caller').replace(/[^\w-]+/g, '_')}.${ext}`, caption: text.slice(0, 1000), title: `Voicemail from ${f.vm.name || f.vm.number || 'caller'}` };
  }

  async markVoicemail(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can change voicemail.' };
    const read = data.read !== false;
    if (/\ball\b/i.test(String(data.from || data._context?.originalInput || ''))) {
      const got = await this.listVoicemails(read);
      if (got.error) return { success: false, error: got.error };
      for (const v of got.list) await this.tool('dialx.mark_voicemail_read', { voicemail_id: v.voicemail_id, read });
      return { success: true, result: `Marked ${got.list.length} voicemail(s) ${read ? 'read' : 'unread'}.` };
    }
    const f = await this.findVoicemail(data);
    if (f.error) return { success: false, error: f.error };
    const r = await this.tool('dialx.mark_voicemail_read', { voicemail_id: f.vm.voicemail_id, read });
    if (!r.ok) return errorResult(r);
    return { success: true, result: `Marked the voicemail from ${f.vm.name || f.vm.number} ${read ? 'read' : 'unread'}.` };
  }

  async deleteVoicemail(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can delete voicemail.' };
    const f = await this.findVoicemail(data);
    if (f.error) return { success: false, error: f.error };
    const who = f.vm.name || f.vm.number || 'that caller';
    const r = await this.tool('dialx.delete_voicemail', { voicemail_id: f.vm.voicemail_id },
      { onLate: (late) => this.agent.notify?.(late.ok && late.result?.status === 'deleted' ? `🗑️ Voicemail from ${who} deleted.` : `Voicemail from ${who} was not deleted.`) });
    if (!r.ok) return errorResult(r);
    if (r.pending) return { success: true, result: `Confirm on the phone to delete the voicemail from ${who}. I'll tell you when it's gone.` };
    return { success: true, result: r.result?.status === 'deleted' ? `Deleted the voicemail from ${who}.` : `DialX answered "${r.result?.status}"; it was not deleted.` };
  }

  async cancel(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can change my calls.' };
    let id = data.call_id || data.id;
    if (!id) {
      const who = String(data.contact || data.name || data.query || '').toLowerCase().trim();
      const r = await this.tool('dialx.list_scheduled_calls');
      if (!r.ok) return errorResult(r);
      const calls = listOf(r.result, 'calls', 'scheduled');
      const hits = calls.filter(c => !who || String(c.contact?.name || c.contact || c.name || '').toLowerCase().includes(who));
      if (!hits.length) return { success: false, error: who ? `No scheduled call to ${who}.` : 'No calls are scheduled.' };
      if (hits.length > 1) return { success: false, error: `More than one scheduled call matches: ${hits.map(c => `${c.contact?.name || c.contact || c.name} at ${when(c.at)}`).join('; ')}. Which one?` };
      id = hits[0].call_id || hits[0].id;
    }
    const r = await this.tool('dialx.cancel_scheduled_call', { call_id: id });
    if (!r.ok) return errorResult(r);
    return { success: true, result: 'Cancelled.' };
  }

  async listing(tool, label, keys) {
    const r = await this.tool(tool, { limit: 20 });
    if (!r.ok) return errorResult(r);
    const items = listOf(r.result, ...keys);
    if (!items.length) return { success: true, result: `No ${label}.` };
    const line = (c) => {
      const who = c.contact?.name || c.contact || c.name || c.number || c.from || 'unknown';
      const t = c.at || c.time || c.date;
      const extra = c.purpose || c.status || c.reason || c.label || '';
      return `- ${who}${t ? ` (${when(t)})` : ''}${extra ? `: ${extra}` : ''}`;
    };
    return { success: true, result: `${label[0].toUpperCase()}${label.slice(1)}:\n${items.slice(0, 20).map(line).join('\n')}`, data: items };
  }
}
