import { BasePlugin } from '../core/basePlugin.js';
import { nowInZone, resolveRequestTime, localZone } from '../../utils/wallClock.js';
import { getTextX } from '../../services/textx/index.js';
import { textxRequest } from '../../services/textx/textxHub.js';
import { isoWithOffset, getDialXSettings, agentAudio, clock, voicemailText, joinToMp3, RECORDING_PART_S, withAiDisclosure, riffPad, thereminize, thereminMode } from '../../services/textx/dialx.js';
import { isTextRequest } from '../../core/pluginChainProcessor.js';
import { supportsRealtime, realtimeVoiceAudio } from '../../services/textx/dialxRealtime.js';

/**
 * Phone calls through the DialX dialer app ("call Wayne and tell him happy birthday at 5pm").
 * DialX pairs like TextX (dashboard → Settings → TextX → Pair) and owns every limit: only
 * contacts the owner approved in DialX for this agent, one confirm card per call, a fixed AI
 * disclosure first, 08:00–21:00 owner time, 3 calls an hour and 10 a day, 5 minutes a call.
 * This plugin asks for the call; the conversation itself runs in the hub (services/textx/dialx.js).
 */

const ERROR_TEXT = {
  // TextX 0.4.41 says too_big, DialX 0.7.8 too_large: a reply too big for the relay (the same thing).
  too_big: 'That is too big to come through from the phone.',
  too_large: 'That is too big to come through from the phone.',
  not_allowed: 'DialX has not allowed that for this agent. Turn it on in DialX: this agent › tools.',
  not_supported: 'DialX says this agent does not support calls yet.',
  outside_hours: null, // DialX's own message names the hours and zone
  rate_limited: null, // the limits are the owner's DialX settings (0.7.22): DialX's message names them
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

export { isTextRequest };

/** How long a read of DialX's approved contacts is reused for the next call. */
const APPROVED_TTL_MS = 10 * 60 * 1000;

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
        usage: 'call({ contact: "Wayne", at: "2026-10-23T17:00", purpose: "wish him a happy birthday", opening: "Hi Wayne! I\'m calling to wish you a happy birthday.", voicemail: "optional: what to leave if voicemail answers, in the user\'s words" })',
        examples: ['call wayne and tell him happy birthday at 5pm', 'phone mom and ask if she needs anything from the store', 'give the plumber a call tomorrow at 9 and confirm the appointment', 'ring Sam now and let him know I\'m running late',
          'leave Adam a voicemail saying I\'ll be late', 'leave Adam a theremin voicemail', 'call Wayne and play him a theremin riff', 'call Sam in a robot voice and say hi']
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
        command: 'recordings',
        description: 'List recorded phone calls from DialX (every recorded call, the user\'s own too)',
        usage: 'recordings({ limit: 20 })',
        examples: ['list my call recordings', 'what calls were recorded today']
      },
      {
        command: 'recording',
        description: 'Send the recording of a call (the latest, or the one with a person) to the user on Telegram',
        usage: 'recording({ from: "Mom" })',
        examples: ['send me the recording of my call with mom', 'play back my last call', 'send me the last call recording']
      },
      {
        command: 'deleteRecording',
        description: 'Delete a call recording, by person or id (the user confirms on the phone)',
        usage: 'deleteRecording({ from: "Mom" })',
        examples: ['delete the recording of my call with mom']
      },
      {
        command: 'reportSpam',
        description: 'Add a number (or the latest caller) to DialX\'s spam list (the user confirms on the phone)',
        usage: 'reportSpam({ number: "+15550100" })',
        examples: ['report that last caller as spam', 'block that spam number in dialx', 'mark +15550100 as spam']
      },
      {
        command: 'notSpam',
        description: 'Take a number off DialX\'s spam list (the user confirms on the phone)',
        usage: 'notSpam({ number: "+15550100" })',
        examples: ['that number is not spam', 'unmark that caller as spam']
      },
      {
        command: 'expecting',
        description: 'Let every caller ring through DialX\'s screening until a time (at most 24 hours), e.g. when the user expects an unknown caller. `hours` or `until` (ISO)',
        usage: 'expecting({ hours: 2 })',
        examples: ["i'm expecting a call from the doctor, let everyone ring for 2 hours", 'let all calls through until 5pm', 'turn off call screening for an hour']
      },
      {
        command: 'callLists',
        description: 'Show one of DialX\'s call lists: `list` is spam (the spam list), allowed (numbers that always ring), blocked (the phone\'s block list), screened (calls DialX screened), or contacts (favorites with favoritesOnly)',
        usage: 'callLists({ list: "spam" })',
        examples: ["what's on my spam list", 'which numbers always ring through', 'show my blocked numbers', 'list my favorite contacts']
      },
      {
        command: 'removeFromList',
        description: 'Take a number off DialX\'s spam or always-ring list, or remove an entry from the screened list. `list`: spam | allowed | screened; `number` (or `from` for a screened caller). Spam/allowed changes are confirmed on the phone',
        usage: 'removeFromList({ list: "allowed", number: "+15550100" })',
        examples: ['take +15550100 off the always-ring list', 'remove that number from my spam list', 'remove the screened call from that number']
      },
      {
        command: 'clearList',
        description: 'Empty DialX\'s spam list or its screened-calls list (confirmed on the phone). `list`: spam | screened',
        usage: 'clearList({ list: "screened" })',
        examples: ['clear my screened calls', 'empty the spam list']
      },
      {
        command: 'importSpam',
        description: 'Import into DialX the numbers the previous phone app had blocked as spam (confirmed on the phone)',
        usage: 'importSpam()',
        examples: ['import my old spam list into dialx']
      },
      {
        command: 'block',
        description: 'Block a number on the phone (no calls or texts), or the latest caller; `unblock: true` to unblock. Confirmed on the phone',
        usage: 'block({ number: "+15550100" })',
        examples: ['block that last caller', 'block +15550100', 'unblock +15550100']
      },
      {
        command: 'deleteRecent',
        description: 'Delete calls from the phone\'s call history: those with a person/number, or the latest one. Confirmed on the phone',
        usage: 'deleteRecent({ from: "+15550100" })',
        examples: ['delete that call from my call history', 'remove the calls from that number from my recents']
      },
      {
        command: 'transcribeVoicemail',
        description: 'Transcribe a voicemail on the phone (the latest, or from a caller) and read what it says',
        usage: 'transcribeVoicemail({ from: "Mom" })',
        examples: ['transcribe my latest voicemail', 'what does the voicemail from mom say word for word']
      },
      {
        command: 'voicePreview',
        description: "Let the user hear a sample of the agent's own voice through a DialX effect (theremin, robot…) before any call, sent to them on Telegram. `voice` is the effect; `text` an optional line to say",
        usage: 'voicePreview({ voice: "theremin", text: "Hello from my new voice" })',
        examples: ['let me hear your theremin voice', 'preview the robot voice', 'what would you sound like in a deep voice', 'play me a sample of your theremin voice']
      },
      {
        command: 'voiceEffect',
        description: "Change the user's own voice on their live phone call with DialX's voice changer (Robot, Deep voice, Woman, Theremin…), or turn it off. `voice` is the effect's name",
        usage: 'voiceEffect({ voice: "Robot" })',
        examples: ['make me sound like a robot on this call', 'give me a deep voice', 'turn off the voice effect', 'make my voice normal again', 'what voice effects are there']
      },
      {
        command: 'theremin',
        description: "Play a short theremin riff on the user's live call (DialX's in-call pad), over their voice. `notes`: semitones above C3, 0-24, optional; `seconds`: how long",
        usage: 'theremin({ seconds: 4 })',
        examples: ['play a theremin riff while I talk', 'do a spooky theremin on this call', 'play some theremin']
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
        case 'voicePreview': return this.wantsACall(data) ? await this.call({ ...data, voice: data.voice || this.effectIn(data) }) : await this.voicePreview(data);
        case 'voiceEffect': return this.wantsACall(data) ? await this.call({ ...data, voice: data.voice || this.effectIn(data) }) : await this.voiceEffect(data);
        case 'recordings': return await this.listing('dialx.list_recordings', 'call recordings', ['recordings'], { limit: Math.min(200, Number(data.limit) || 20) });
        case 'recording': return await this.recording(data);
        case 'deleteRecording': return await this.deleteRecording(data);
        case 'reportSpam': return await this.spam('dialx.report_spam', data);
        case 'notSpam': return await this.spam('dialx.mark_not_spam', data);
        case 'expecting': return await this.expecting(data);
        case 'callLists': return await this.callLists(data);
        case 'removeFromList': return await this.removeFromList(data);
        case 'clearList': return await this.clearList(data);
        case 'importSpam': return await this.ownerTool('dialx.import_spam_from_history', {}, data, 'import the old spam list', (r) => `Imported ${r?.added ?? 'the'} numbers into DialX's spam list.`);
        case 'block': return await this.block(data);
        case 'deleteRecent': return await this.deleteRecent(data);
        case 'transcribeVoicemail': return await this.transcribeVoicemail(data);
        case 'theremin': return this.wantsACall(data) ? await this.call({ ...data, voice: data.voice || 'theremin' }) : await this.theremin(data);
        case 'voicemails': return this.wantsACall(data) ? await this.call({ ...data, voice: data.voice || this.effectIn(data) }) : await this.voicemails(data);
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

  // ── recordings (DialX 0.7.0 "Call recordings" switch) ─────────────────────────────────

  async findRecording(data) {
    const r = await this.tool('dialx.list_recordings', { limit: 200 });
    if (!r.ok) return { error: r.error?.code === 'not_allowed' || r.error?.code === 'none'
      ? 'Call recordings are off for me in DialX. Turn on "Call recordings" for this agent in DialX.' : errorResult(r).error };
    const list = listOf(r.result, 'recordings').sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (!list.length) return { error: 'DialX has no call recordings.' };
    if (data.id || data.recording_id) {
      const hit = list.find(x => String(x.recording_id) === String(data.id || data.recording_id));
      return hit ? { rec: hit } : { error: 'No recording with that id.' };
    }
    const q = String(data.from || data.contact || data.name || '').toLowerCase().trim();
    if (!q) return { rec: list[0] };
    const digits = q.replace(/\D/g, '');
    const hit = list.find(x => String(x.name || '').toLowerCase().includes(q) || (digits.length >= 4 && String(x.number || '').replace(/\D/g, '').endsWith(digits)));
    return hit ? { rec: hit } : { error: `No recorded call with ${data.from || data.contact || data.name}.` };
  }

  async recording(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can hear call recordings.' };
    const f = await this.findRecording(data);
    if (f.error) return { success: false, error: f.error };
    const id = f.rec.recording_id;
    const first = await this.tool('dialx.get_recording_audio', { recording_id: id, part: 0, seconds: RECORDING_PART_S });
    if (!first.ok || !first.result?.audio_b64) return { success: false, error: errorResult(first).error };
    const parts = Math.max(1, Math.min(20, Number(first.result.parts) || 1));
    const wavs = [Buffer.from(first.result.audio_b64, 'base64')];
    for (let i = 1; i < parts; i++) {
      const r = await this.tool('dialx.get_recording_audio', { recording_id: id, part: i, seconds: RECORDING_PART_S });
      if (!r.ok || !r.result?.audio_b64) break;
      wavs.push(Buffer.from(r.result.audio_b64, 'base64'));
    }
    const mp3 = await joinToMp3(wavs);
    const tg = this.agent?.interfaces?.get?.('telegram');
    const who = f.rec.name || f.rec.number || 'a call';
    if (!tg?.sendNotification || !(mp3 || wavs.length === 1)) return { success: false, error: "I couldn't prepare the recording to send." };
    await tg.sendNotification(`🎙️ Call with ${who}, ${when(f.rec.at)}${wavs.length < parts ? ` (${wavs.length} of ${parts} minutes)` : ''}. Left: your side, right: theirs.`,
      { [mp3 ? 'audio' : 'document']: { source: mp3 || wavs[0], filename: `call-${String(who).replace(/[^\w-]+/g, '_')}.${mp3 ? 'mp3' : 'wav'}` }, parse_mode: undefined });
    return { success: true, result: `Sent you the recording of the call with ${who} (${when(f.rec.at)}) on Telegram.` };
  }

  async deleteRecording(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can delete call recordings.' };
    const f = await this.findRecording(data);
    if (f.error) return { success: false, error: f.error };
    const r = await this.tool('dialx.delete_recording', { recording_id: f.rec.recording_id });
    if (!r.ok) return errorResult(r);
    return { success: true, result: r.pending ? `Confirm on the phone to delete the recording of the call with ${f.rec.name || f.rec.number}.` : 'Deleted.' };
  }

  // ── spam list and "expecting a call" (owner confirms each on the phone) ───────────────

  async spam(tool, data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can change the spam list.' };
    let number = String(data.number || '').trim();
    if (!number) {
      // "that last caller": the newest call in the phone's recents
      const r = await this.tool('dialx.list_recents', { limit: 5 });
      const last = r.ok ? listOf(r.result, 'calls', 'recents')[0] : null;
      if (!last?.number) return { success: false, error: 'Which number?' };
      number = last.number;
    }
    const r = await this.tool(tool, { number });
    if (!r.ok) return errorResult(r);
    const what = tool === 'dialx.report_spam' ? 'add' : 'take';
    return { success: true, result: r.pending ? `Confirm on the phone to ${what} ${number} ${what === 'add' ? 'to' : 'off'} DialX's spam list.`
      : `${number} is ${what === 'add' ? 'on' : 'off'} DialX's spam list.` };
  }

  async expecting(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can change call screening.' };
    let until = null;
    if (data.until) {
      const d = resolveRequestTime(data.until, String(data._context?.originalInput || ''));
      if (d) until = d;
    } else {
      const h = Number(data.hours) || (Number(data.minutes) ? Number(data.minutes) / 60 : 1);
      until = new Date(Date.now() + Math.min(24, Math.max(0.1, h)) * 3600000);
    }
    if (!until) return { success: false, error: `I couldn't read the time "${data.until}".` };
    if (until.getTime() - Date.now() > 24 * 3600000) until = new Date(Date.now() + 24 * 3600000);
    const r = await this.tool('dialx.set_expecting', { until: isoWithOffset(until, localZone()) });
    if (!r.ok) return errorResult(r);
    return { success: true, result: r.pending ? `Confirm on the phone: every caller rings until ${when(until)}.` : `Every caller rings through until ${when(until)}.` };
  }

  // ── call lists and history (DialX owner tools) ────────────────────────────────────────

  /** An owner-only, phone-confirmed tool: says "confirm on the phone" while the card waits. */
  async ownerTool(tool, args, data, what, done) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can change that.' };
    const r = await this.tool(tool, args);
    if (!r.ok) return r.error?.code === 'not_default_dialer'
      ? { success: false, error: "DialX can't block numbers unless it's set as the phone app." } : errorResult(r);
    return { success: true, result: r.pending ? `Confirm on the phone to ${what}.` : done(r.result) };
  }

  async callLists(data) {
    const which = String(data.list || data.which || '').toLowerCase();
    const map = { spam: ['dialx.list_spam', 'spam list', ['spam', 'numbers']], allowed: ['dialx.list_allowed', 'always-ring list', ['allowed', 'numbers']],
      blocked: ['dialx.list_blocked', 'blocked numbers', ['blocked', 'numbers']], screened: ['dialx.list_screened', 'screened calls', ['calls', 'screened']],
      contacts: ['dialx.list_contacts', data.favoritesOnly || data.favorites ? 'favorite contacts' : 'contacts', ['contacts']] };
    const key = Object.keys(map).find(k => which.startsWith(k.slice(0, 4))) || (/always|white/.test(which) ? 'allowed' : /block/.test(which) ? 'blocked' : null);
    if (!key) return { success: false, error: 'Which list: spam, allowed (always ring), blocked, screened or contacts?' };
    const [tool, label, keys] = map[key];
    const args = key === 'contacts' ? { limit: 500, ...(data.favoritesOnly || data.favorites ? { favorites_only: true } : {}) } : key === 'screened' ? { limit: 50 } : {};
    return this.listing(tool, label, keys, args);
  }

  async removeFromList(data) {
    const list = String(data.list || '').toLowerCase();
    if (list.startsWith('screen')) {
      if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can change that.' };
      const r = await this.tool('dialx.list_screened', { limit: 50 });
      const q = String(data.number || data.from || '').replace(/\D/g, '');
      const hit = r.ok ? listOf(r.result, 'calls', 'screened').find(x => q && String(x.number || '').replace(/\D/g, '').endsWith(q.slice(-7))) : null;
      if (!hit?.screened_id) return { success: false, error: 'No screened call matches that number.' };
      return this.ownerTool('dialx.remove_screened', { screened_id: hit.screened_id }, data, 'remove it', () => 'Removed from the screened list.');
    }
    const number = String(data.number || '').trim();
    if (!number) return { success: false, error: 'Which number?' };
    if (list.startsWith('spam')) return this.ownerTool('dialx.remove_spam', { number }, data, `take ${number} off the spam list`, () => `${number} is off the spam list.`);
    if (/allow|always/.test(list)) return this.ownerTool('dialx.remove_allowed', { number }, data, `take ${number} off the always-ring list`, () => `${number} is screened again.`);
    return { success: false, error: 'Which list: spam, allowed or screened?' };
  }

  async clearList(data) {
    const list = String(data.list || '').toLowerCase();
    if (list.startsWith('spam')) return this.ownerTool('dialx.clear_spam', {}, data, 'empty the spam list', () => 'The spam list is empty.');
    if (list.startsWith('screen')) return this.ownerTool('dialx.clear_screened', {}, data, 'clear the screened calls', () => 'Screened calls cleared.');
    return { success: false, error: 'Which list: spam or screened?' };
  }

  async latestCaller() {
    const r = await this.tool('dialx.list_recents', { limit: 5 });
    return r.ok ? listOf(r.result, 'calls', 'recents')[0] || null : null;
  }

  async block(data) {
    const number = String(data.number || '').trim() || (await this.latestCaller())?.number;
    if (!number) return { success: false, error: 'Which number?' };
    return data.unblock
      ? this.ownerTool('dialx.unblock_number', { number }, data, `unblock ${number}`, () => `${number} is unblocked.`)
      : this.ownerTool('dialx.block_number', { number }, data, `block ${number} (calls and texts)`, () => `${number} is blocked.`);
  }

  async deleteRecent(data) {
    const r = await this.tool('dialx.list_recents', { limit: 50 });
    if (!r.ok) return errorResult(r);
    const items = listOf(r.result, 'calls', 'recents');
    const q = String(data.from || data.number || '').toLowerCase().trim();
    const digits = q.replace(/\D/g, '');
    const hits = q ? items.filter(x => String(x.name || '').toLowerCase().includes(q) || (digits.length >= 4 && String(x.number || '').replace(/\D/g, '').endsWith(digits))) : items.slice(0, 1);
    const ids = hits.map(x => x.entry_id).filter(v => v != null);
    if (!ids.length) return { success: false, error: q ? `No calls with ${q} in the history.` : 'The call history is empty.' };
    return this.ownerTool('dialx.delete_recents', { entry_ids: ids }, data, `delete ${ids.length} call${ids.length === 1 ? '' : 's'} from the history`, () => `Deleted ${ids.length} call${ids.length === 1 ? '' : 's'} from the history.`);
  }

  async transcribeVoicemail(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can read voicemail.' };
    const { list, error } = await this.listVoicemails(false);
    if (error) return { success: false, error };
    const q = String(data.from || '').toLowerCase();
    const vm = (q ? list.filter(v => String(v.name || v.number || '').toLowerCase().includes(q)) : list)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (!vm) return { success: false, error: q ? `No voicemail from ${data.from}.` : 'No voicemails.' };
    const r = await this.tool('dialx.transcribe_voicemail', { voicemail_id: vm.voicemail_id });
    if (!r.ok) {
      const why = { no_audio: "the phone doesn't have that voicemail's audio", no_model: "DialX's speech model isn't installed", unreadable: "the audio couldn't be read" }[r.error?.code];
      return { success: false, error: why ? `I couldn't transcribe it: ${why}.` : errorResult(r).error };
    }
    // Their words, shown to the owner, never followed.
    return { success: true, result: `Voicemail from ${vm.name || vm.number} (${when(vm.at)}):\n"${String(r.result?.transcript || '').trim()}"` };
  }

  /**
   * DialX 0.7.17 voice_preview: the agent's own voice for a sample line, through the effect a call
   * would use, rendered on the phone with no call placed, and sent to the owner on Telegram.
   */
  async voicePreview(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can ask for that.' };
    const asked = String(data.voice || this.effectIn(data) || 'theremin');
    const effect = thereminMode(asked);
    if (effect) return this.localPreview(data, effect);
    const v = await this.agentVoice(asked);
    if (v.error) return { success: false, error: v.error };
    const { name } = { name: this.agent?.config?.name || process.env.AGENT_NAME || 'your assistant' };
    const text = String(data.text || `Hi, this is ${name}, ${process.env.OWNER_NAME || 'my owner'}'s AI assistant, in my ${v.voice} voice. This is how I would sound on a call.`).slice(0, 400);
    const device = await this.device('dialx.voice_preview');
    const audio = await agentAudio(this.agent, device, text, { ...(await this.settings()), voice: 'agent' }, this.logger);
    const args = { voice: v.voice, ...(audio ? { audio_b64: audio.audio_b64, format: audio.format } : { text }),
      ...(/theremin/i.test(v.voice) ? { pad: riffPad({ seconds: 8, bend: /^thereminvoice$/i.test(v.voice) }) } : {}) };
    const r = await this.tool('dialx.voice_preview', args);
    if (!r.ok || !r.result?.audio_b64) {
      // No phone lists voice_preview until DialX 0.7.17 is installed (the tool arrives in its hello).
      const old = ['none', 'unknown_tool'].includes(r.error?.code);
      return { success: false, error: old ? 'DialX has no voice preview yet (DialX 0.7.17 adds it), or Voice effects is off for me.' : (r.ok ? 'DialX sent no audio.' : errorResult(r).error) };
    }
    const wav = Buffer.from(r.result.audio_b64, 'base64');
    const mp3 = await joinToMp3([wav]);
    const tg = this.agent?.interfaces?.get?.('telegram');
    if (!tg?.sendNotification) return { success: false, error: "Telegram isn't available to send the sample." };
    await tg.sendNotification(`🎛️ Sample of my ${v.voice} voice (${Math.round((r.result.duration_ms || 0) / 1000)} s), as a call would sound.`,
      { [mp3 ? 'audio' : 'document']: { source: mp3 || wav, filename: `voice-${v.voice}.${mp3 ? 'mp3' : 'wav'}` }, parse_mode: undefined });
    return { success: true, result: `Sent you a sample of my ${v.voice} voice on Telegram.` };
  }

  /** A theremin sample made here (the sound calls now use), sent to the owner's Telegram. */
  async localPreview(data, effect) {
    const name = this.agent?.config?.name || process.env.AGENT_NAME || 'your assistant';
    const text = String(data.text || `Hi, this is ${name}, ${process.env.OWNER_NAME || 'my owner'}'s AI assistant, in my theremin voice. This is how I would sound on a call.`).slice(0, 400);
    const device = await this.device('dialx.schedule_call');
    const audio = await agentAudio(this.agent, device, text, { ...(await this.settings()), voice: 'agent', effect, ttsTimeoutMs: 15000 }, this.logger);
    if (!audio) return { success: false, error: "I couldn't make the sample (no voice or ffmpeg)." };
    const tg = this.agent?.interfaces?.get?.('telegram');
    if (!tg?.sendNotification) return { success: false, error: "Telegram isn't available to send the sample." };
    const label = effect === 'mix' ? 'theremin mix (voice with a theremin under it)' : 'theremin voice';
    await tg.sendNotification(`🎛️ Sample of my ${label}, as a call would sound.`,
      { audio: { source: Buffer.from(audio.audio_b64, 'base64'), filename: `theremin-${effect}.mp3` }, parse_mode: undefined });
    return { success: true, result: `Sent you a sample of my ${label} on Telegram.` };
  }

  /** "robot" → DialX's name for it, from voice_status.agent_choices (theremins are the owner's only). */
  async agentVoice(asked) {
    const r = await this.tool('dialx.voice_status');
    if (!r.ok) return { error: r.error?.code === 'not_allowed' || r.error?.code === 'none'
      ? 'Voice effects are off for me in DialX. Turn on "Voice effects" for this agent in DialX.' : errorResult(r).error };
    const choices = (r.result?.agent_choices || []).map(String).filter(c => !/^off$/i.test(c));
    if (!choices.length) return { error: 'This DialX version cannot put an effect on my voice yet (DialX 0.7.14 adds it).' };
    const q = asked.toLowerCase().replace(/[\s-]+/g, '').replace(/voice$/, '');
    const norm = (c) => c.toLowerCase().replace(/[\s-]+/g, '').replace(/voice$/, '');
    // A plain "theremin" is the agent's own voice bent by the theremin (ThereminVoice), as the owner
    // wants it (2026-10-24); never the tone-only "Theremin", which would carry none of the words or the
    // AI disclosure. "theremin mix" / "with a theremin behind" asks for ThereminMix by name.
    const bent = choices.find(c => /^thereminvoice$/i.test(c));
    const pick = (/theremin/.test(q) && !/mix|behind|background|under/.test(q) && bent) ? bent
      : (/theremin/.test(q) && /mix|behind|background|under/.test(q)) ? choices.find(c => /^thereminmix$/i.test(c))
        : choices.find(c => norm(c) === q) || choices.find(c => norm(c).includes(q) || q.includes(norm(c)));
    return pick ? { voice: pick } : { error: `DialX has no "${asked}" effect for my voice. It has: ${choices.join(', ')}.` };
  }

  // ── voice effects (DialX 0.7.6): the owner's voice on the owner's own live call ─────────

  async voiceStatus() {
    const r = await this.tool('dialx.voice_status');
    if (!r.ok) return { error: r.error?.code === 'not_allowed' || r.error?.code === 'none'
      ? 'Voice effects are off for me in DialX. Turn on "Voice effects" for this agent in DialX (it needs root).' : errorResult(r).error };
    return { status: r.result || {} };
  }

  async voiceEffect(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can change their call voice.' };
    const st = await this.voiceStatus();
    if (st.error) return { success: false, error: st.error };
    const choices = (st.status.choices || []).map(String);
    const asked = String(data.voice || data.effect || '').trim();
    if (!asked) return { success: true, result: `Voice effects: ${choices.join(', ') || 'none listed'}. Now: ${st.status.label || st.status.voice || 'normal'}.` };
    const q = asked.toLowerCase().replace(/\s+/g, '');
    const off = /^(off|none|normal|regular|myvoice|default|stop)$/.test(q);
    const pick = off
      ? choices.find(c => /^(normal|off|none|natural)/i.test(c))
      : choices.find(c => c.toLowerCase().replace(/\s+/g, '') === q) || choices.find(c => c.toLowerCase().replace(/\s+/g, '').includes(q)) || choices.find(c => q.includes(c.toLowerCase().replace(/\s+/g, '')));
    if (!pick) return { success: false, error: `DialX has no "${asked}" voice. It has: ${choices.join(', ')}.` };
    const r = await this.tool('dialx.set_voice', { voice: pick });
    if (!r.ok) return { success: false, error: r.error?.code === 'agent_call' ? "I can't change your voice while I'm on a call myself." : errorResult(r).error };
    return { success: true, result: off ? 'Your voice is back to normal.' : `Done: you sound like ${pick}${st.status.call_up ? ' on this call' : ' on your next call'}.` };
  }

  /** A short riff on the pad: x is pitch (two octaves from C3), y the level. */
  async theremin(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can use their call voice.' };
    const st = await this.voiceStatus();
    if (st.error) return { success: false, error: st.error };
    if (!/theremin/i.test(String(st.status.voice || ''))) {
      const choices = (st.status.choices || []).map(String);
      const mix = choices.find(c => /^thereminmix$/i.test(c)) || choices.find(c => /theremin/i.test(c));
      if (!mix) return { success: false, error: 'DialX lists no theremin voice.' };
      const r = await this.tool('dialx.set_voice', { voice: mix });
      if (!r.ok) return { success: false, error: errorResult(r).error };
    }
    const notes = Array.isArray(data.notes) && data.notes.length
      ? data.notes.map(Number).filter(n => Number.isFinite(n)).map(n => Math.max(0, Math.min(24, n)))
      : [0, 7, 12, 15, 19, 15, 12, 7, 12, 24, 19, 12]; // a spooky minor arpeggio
    const seconds = Math.max(1, Math.min(15, Number(data.seconds) || 4));
    // DialX 0.7.16 plays a whole riff from one call; older versions answer bad_args and get the point-by-point path.
    const whole = await this.tool('dialx.theremin', { points: riffPad({ notes, seconds, level: 0.25 }) });
    if (whole.ok) return { success: true, result: `Playing a ${seconds}-second theremin riff${st.status.call_up ? '' : ' (you are not on a call, so only the pad moved)'}.` };
    const step = (seconds * 1000) / notes.length;
    for (const n of notes) {
      const r = await this.tool('dialx.theremin', { x: Number((n / 24).toFixed(3)), y: 0.25, touching: true });
      if (!r.ok) return { success: false, error: errorResult(r).error };
      await new Promise(res => setTimeout(res, step));
    }
    await this.tool('dialx.theremin', { x: 0.5, y: 0.25, touching: false });
    return { success: true, result: `Played a ${seconds}-second theremin riff${st.status.call_up ? '' : ' (you are not on a call, so only the pad moved)'}.` };
  }

  /**
   * "Leave Adam a theremin voicemail" routed to the voicemail list, and "call Wayne and play him a
   * theremin riff" to the owner's own pad (2026-10-24; Orbit's model made the same mistake). A request
   * to call someone or leave them a voicemail is a call, whichever action matched.
   */
  wantsACall(data) {
    const said = String(data._context?.originalInput || data.originalInput || '');
    return /\b(call|ring|phone|dial)\s+(?!me\b|my\b|back\b)\w+/i.test(said) || /\bleave\s+(?!me\b)\w+\s+(a|an)\b[^.]*\bvoice ?mail\b/i.test(said);
  }

  /** The effect a call request names ("in a robot voice", "a theremin voicemail"). */
  effectIn(data) {
    const said = String(data._context?.originalInput || data.originalInput || '').toLowerCase();
    const m = said.match(/\b(theremin|robot|deep|woman|auto ?tune|chipmunk|alien|echo)\b/);
    return m ? m[1] : undefined;
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
    // 'web-user' is the logged-in dashboard and the API key (POST /api/command/execute); refusing it
    // turned the owner away from their own dashboard (2026-10-24).
    return !!textxRequest.getStore()?.deviceId || !uid || uid === 'web-user' || String(uid) === String(process.env.TELEGRAM_USER_ID || '');
  }

  async call(data) {
    if (!this.fromOwner(data)) return { success: false, error: 'Only my owner can ask me to place calls.' };
    const request = String(data._context?.originalInput || data.originalInput || '');
    // "Alice text Wayne and ask him to call…" matched this action on the word "call" and phoned Wayne
    // (2026-10-24). A request that starts by asking for a text is a text: it goes to TextX, never a call.
    if (isTextRequest(request)) {
      const tx = this.agent?.apiManager?.apis?.get?.('textx');
      const plugin = tx?.instance || tx;
      this.logger.warn(`dialx call: "${request.slice(0, 80)}" asks for a text; sending it through TextX instead of calling`);
      if (plugin?.execute) return plugin.execute({ action: 'send', needsParameterExtraction: true, _context: data._context, originalInput: request });
      return { success: false, error: "That asks for a text, and I can't send texts right now, so I didn't call." };
    }
    if (data.needsParameterExtraction || !data.contact || !data.opening || !data.voicemail) await this.extract(data, request);
    const who = String(data.contact || data.to || data.name || '').trim();
    if (!who) return { success: false, error: 'Who should I call?' };
    const purpose = String(data.purpose || data.message || '').trim();
    const opening = String(data.opening || '').trim();
    if (!purpose && !opening) return { success: false, error: `What should I say to ${who}?` };

    // A repeat call reuses the approved list for a few minutes: each round trip to a phone that
    // only polls costs up to 15 s before the call even starts (call 7, 2026-10-24). DialX checks
    // approval itself at dialing; a stale list costs one refusal, then a fresh read.
    const cached = !data._freshContacts && this._approved && Date.now() - this._approved.at < APPROVED_TTL_MS ? this._approved.list : null;
    let approved = cached;
    if (!approved) {
      const list = await this.tool('dialx.list_approved_contacts');
      if (!list.ok) return errorResult(list);
      approved = listOf(list.result, 'contacts').map(contactOf).filter(c => c.name || c.number);
      this._approved = { at: Date.now(), list: approved };
    }
    // DialX 0.3.4 (Trellis 4293 #23): an approved contact is called with no card; anyone else
    // goes to the owner's confirm card for that one call. So a name not on the list is looked up
    // in the phone's contacts and sent by number, and the phone asks the owner.
    let pick = this.match(approved, who);
    if (pick.error && !pick.ambiguous) {
      const found = await this.lookup(who);
      if (found.error) return { success: false, error: found.error };
      pick = found;
    }
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
    let voice = null;
    // A theremin voice is made here, from the agent's own TTS, with the sound the owner approved
    // (Orbit's recipe, 4293 #159); DialX's own theremin chain sounded bad (2026-10-24). Other effects
    // (Robot, Deep…) still go through DialX's `voice`.
    const effect = thereminMode(data.voice);
    if (data.voice && !effect && !/^(none|null|off|normal|plain)$/i.test(String(data.voice).trim())) {
      const v = await this.agentVoice(String(data.voice));
      if (v.error) return { success: false, error: v.error };
      voice = v.voice;
    }
    const settings = await this.settings();
    // The name the owner used ("Wayne") over the phone book's ("CommanderFog Wayne") when it is part of it.
    const said = String(data.contact || '').trim();
    const spoken = said && String(pick.contact.name || '').toLowerCase().split(/\s+/).includes(said.toLowerCase()) ? said : pick.contact.name;
    const line = withAiDisclosure(opening || `Hi ${pick.contact.name || 'there'}! I'm calling about ${purpose}.`,
      { name: spoken, self: this.agent?.config?.name || process.env.AGENT_NAME, owner: process.env.OWNER_NAME });
    // DialX 0.6.0/0.6.1: what to leave after the beep, as text and (0.6.1) in ALICE's own voice,
    // rendered now with the opening so voicemail never waits on a round trip.
    const vmText = withAiDisclosure(voicemailText({ name: spoken, owner: process.env.OWNER_NAME, self: this.agent?.config?.name || process.env.AGENT_NAME,
      purpose: purpose || '', given: data.voicemail }), { name: spoken, self: this.agent?.config?.name || process.env.AGENT_NAME, owner: process.env.OWNER_NAME });
    // A realtime call speaks in the realtime voice, so its opening (the fallback if realtime fails) and its voicemail are
    // made in that voice too: one call, one voice (DialX 0.7.48 #250). A voice effect keeps the agent's own TTS.
    const rtVoice = supportsRealtime(device) && !voice && !effect && settings.realtimeCalls === 'all' ? settings.realtimeVoice : null;
    const render = async (text) => (rtVoice && await realtimeVoiceAudio(text, { voice: rtVoice, maxBytes: device?.maxAudioBytes || 262144 })) ||
      agentAudio(this.agent, device, text, effect ? { ...settings, effect } : settings, this.logger);
    const [audio, vmAudio] = await Promise.all([render(line), render(vmText)]);
    const args = {
      ...(pick.contact.id != null ? { contact_id: pick.contact.id } : { number: pick.contact.number }),
      ...(at ? { at: isoWithOffset(at, localZone()) } : {}),
      purpose: purpose || line,
      opening: line,
      voicemail: vmText, // the transcript of voicemail_audio_b64, or what the phone speaks without it
      ...(audio ? { opening_audio_b64: audio.audio_b64 } : {}),
      ...(vmAudio ? { voicemail_audio_b64: vmAudio.audio_b64 } : {}),
      requested_by_owner: true,
      // Realtime (Trellis 4293 #191/#196): the phone streams to OpenAI Realtime once someone answers.
      // A voice effect stays on the turn path, which renders each line through it.
      ...(supportsRealtime(device) && !voice && settings.realtimeCalls === 'all' ? { realtime: true } : {}),
      // DialX 0.7.14: the agent's own lines through a voice effect, only when the owner asked for one.
      ...(voice ? { voice } : {}),
      // DialX 0.7.16: a theremin voice plays from a pad script, one riff that serves every line of the call.
      ...(voice && /theremin/i.test(voice) ? { pad: riffPad({ notes: Array.isArray(data.notes) ? data.notes : undefined, seconds: data.seconds || 6, bend: /^thereminvoice$/i.test(voice) }) } : {})
    };
    const name = pick.contact.name || who;
    const r = await this.tool('dialx.schedule_call', args, {
      onLate: (late) => this.agent.notify?.(late.ok ? `📞 ${this.outcome(late.result, name, args.at, line)}` : `⚠️ Call to ${name}: ${errorResult(late).error}`)
    });
    if (!r.ok && cached && r.error?.code === 'not_approved') {
      this._approved = null;
      return this.call({ ...data, _freshContacts: true });
    }
    if (!r.ok) {
      // A refused call left no trace but the owner's reply (call to Wayne, 2026-10-25 14:43).
      this.logger.warn(`dialx call to ${name} refused: ${r.error?.code || 'no code'} ${r.error?.message || ''}`);
      return errorResult(r);
    }
    // Recorded at once: the deploy quiet gate holds a restart from now until the call has ended,
    // not just from call.started (the first live call's restart landed in that gap, 2026-10-23).
    if (r.result?.call_id) {
      await this.hub?.dialx?.store?.plan?.({ callId: String(r.result.call_id), contact: name, number: pick.contact.number || '', voicemail: args.voicemail, opening: line, ...(effect ? { effect } : {}), purpose: purpose || line,
        plannedAt: new Date(r.result.at || args.at || Date.now()) })?.catch?.(e => this.logger.warn(`dialx: call not recorded: ${e.message}`));
    }
    const time = args.at ? `at ${when(args.at)}` : 'now';
    // Only someone off the approved list gets a confirm card. An approved contact never does: a
    // pending answer there just means the phone hasn't replied yet (offline or asleep).
    if (r.pending) {
      return { success: true, result: pick.unapproved
        ? `${name} isn't on my approved list, so DialX is asking you on the phone: calling ${name} ${time} (${purpose || line}). Tap Approve there; I'll tell you when it's set.`
        : `I've asked DialX to call ${name} ${time}; the phone hasn't answered yet (it may be offline). No approval is needed for ${name}. I'll tell you when it's scheduled.` };
    }
    return { success: true, result: this.outcome(r.result, name, args.at, line) };
  }

  /** schedule_call's result: {status: "scheduled", call_id, at} | {status: "declined"} | {status: "timeout"} (DialX 0.2.0). */
  outcome(result, name, at, line) {
    const status = String(result?.status || 'scheduled');
    if (status === 'declined') return `You declined the call to ${name} on the phone, so it won't happen.`;
    if (status === 'timeout') return `The call to ${name} wasn't approved on the phone in time, so it isn't scheduled. Ask again to retry.`;
    if (status === 'scheduled') return `Call to ${name} scheduled ${result?.at || at ? `for ${when(result?.at || at)}` : 'for now'}: I'll open with "${line}" and tell you how it went.`;
    return `Call to ${name}: DialX answered "${status}".`;
  }

  /** One approved contact for the name, or an error that lists the choices. */
  match(approved, who) {
    if (!approved.length) return { error: 'No contacts are approved for me in DialX yet.' };
    const q = who.toLowerCase();
    const digits = who.replace(/\D/g, '');
    const exact = approved.filter(c => c.name.toLowerCase() === q || (digits.length >= 7 && c.number.replace(/\D/g, '').endsWith(digits)));
    const hits = exact.length ? exact : approved.filter(c => c.name.toLowerCase().split(/\s+/).includes(q) || c.name.toLowerCase().includes(q));
    if (hits.length === 1) return { contact: hits[0] };
    const names = approved.map(c => c.name || c.number).slice(0, 12).join(', ');
    if (!hits.length) return { error: `${who} isn't on my approved list in DialX (approved: ${names}).` };
    return { ambiguous: true, error: `"${who}" matches more than one approved contact: ${hits.map(c => c.name).join(', ')}. Which one?` };
  }

  /** Someone not on the approved list: one number from the phone's contacts (or the number itself). */
  async lookup(who) {
    const digits = who.replace(/\D/g, '');
    if (digits.length >= 7 && /^[+\d\s().-]+$/.test(who.trim())) return { contact: { id: null, name: who, number: who.trim() }, unapproved: true };
    const r = await this.tool('dialx.contacts_lookup', { query: who, limit: 5 });
    if (!r.ok) return { error: r.error?.code === 'not_allowed' || r.error?.code === 'none'
      ? `${who} isn't on my approved list in DialX, and contact lookup is off for me there, so I can't find their number. Approve them in DialX or give me the number.`
      : errorResult(r).error };
    const people = listOf(r.result, 'contacts').filter(c => (c.numbers || (c.number ? [c.number] : [])).length);
    const exact = people.filter(c => String(c.name || '').toLowerCase() === who.toLowerCase());
    const pool = exact.length ? exact : people;
    const options = pool.flatMap(c => (c.numbers || [c.number]).map(n => ({ name: c.name, number: n })));
    if (!options.length) return { error: `No contact on the phone matches "${who}".` };
    if (options.length > 1) return { ambiguous: true, error: `"${who}" matches more than one number: ${options.slice(0, 6).map(o => `${o.name} ${o.number}`).join('; ')}. Which one?` };
    return { contact: { id: null, name: options[0].name || who, number: options[0].number }, unapproved: true };
  }

  async extract(data, request) {
    const pm = this.agent?.providerManager;
    if (!request || !pm?.generateResponse) return;
    const owner = process.env.OWNER_NAME || 'the user';
    const name = this.agent?.config?.name || process.env.AGENT_NAME || 'the assistant';
    try {
      const res = await pm.generateResponse(
        `${owner} asked you, ${name}, to make a phone call. Request: ${request}\n` +
        'Extract one JSON object {"contact": who to call, "at": when, "purpose": why, "opening": first line, "voicemail": message to leave, "voice": a voice effect for your voice on this call}.\n' +
        '- "voice": only when the request asks for one ("in a robot voice", "a deep voice", "autotune"): its name, e.g. "Robot"; otherwise null.\n' +
        '- "at": the wall-clock time they said, YYYY-MM-DDTHH:mm with no offset or Z (a time with no date that has ' +
        `already passed today means tomorrow); null for now. Local now is ${nowInZone()}.\n` +
        `- "purpose": what ${owner} wants from the call, in a few words ("wish Wayne a happy birthday").\n` +
        `- "opening": the first thing you will say to them. It may be the first thing they hear, so it must say who you ` +
        `are and that you are an AI: one or two warm, spoken sentences addressed to them, starting "Hi <name>, this is ${name}, ` +
        `${owner}'s AI assistant" and carrying ${owner}'s message ("Hi Wayne, this is ${name}, ${owner}'s AI assistant. ` +
        `${owner} asked me to call and wish you a very happy birthday."). No emoji or symbols.\n` +
        `- "voicemail": what to leave if voicemail answers, after the phone says you are ${owner}'s AI assistant: two or ` +
        `three short spoken sentences to them by first name: that you are ${name} calling for ${owner}, the message or ` +
        `reason in plain words, and to call ${owner} back. ${owner}'s own words when the request gives a message for ` +
        'voicemail. The same tone as the opening. Under 400 characters, no emoji or symbols.\n' +
        'Leave out what the request does not say. Answer the JSON only.',
        { maxTokens: 300, temperature: 0.3 });
      const raw = String(res?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
      const got = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) || {};
      for (const k of ['contact', 'at', 'purpose', 'opening', 'voicemail', 'voice']) {
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

  async listing(tool, label, keys, args = { limit: 20 }) {
    const r = await this.tool(tool, args);
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
