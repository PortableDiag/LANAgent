/**
 * Invitations in shared conversations ("BBQ at mine Saturday at 6, you coming?").
 *
 * The agent never accepts or declines on its own unless the owner chose that. What it does is set
 * by TEXTX_INVITES:
 *   ask      (default) the sender gets "I'll pass it on"; the owner gets the invitation, what their
 *            calendar holds then, and Accept / Decline / Add to calendar buttons.
 *   pass_on  the same holding reply and buttons, no calendar check and no "want to go?": for an
 *            owner who usually doesn't go, free or not. Nothing happens unless they tap.
 *   decline  the auto-reply declines politely for them (only where auto-reply is on); the owner is
 *            told and can still accept.
 */
import { untrusted, formatMessage } from './textxHub.js';

export const INVITE_MODES = ['ask', 'pass_on', 'decline'];
const TTL_MS = 14 * 24 * 3600 * 1000;

export function inviteMode() {
  const v = String(process.env.TEXTX_INVITES || 'ask').trim().toLowerCase().replace(/[-\s]/g, '_');
  return INVITE_MODES.includes(v) ? v : 'ask';
}

// A cheap gate before the model call: plans, a day or a time.
const HINT = /\b(?:come|coming|join|invit\w*|party|bbq|barbe?cue|dinner|lunch|brunch|breakfast|drinks?|wedding|birthday|shower|meet ?up|hang ?out|get[- ]together|game night|concert|show|event|rsvp|tonight|tomorrow|this weekend|next week|(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{1,2}(?::\d{2})?\s*(?:am|pm)|at \d{1,2}\b)/i;
export const mayBeInvite = (text) => HINT.test(String(text || ''));

const pending = new Map();

/** The invitation in a new message, or null. */
export async function detectInvite(generate, { m, recent = [], names, now = new Date() }) {
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const res = await generate(
    `Now: ${now.toISOString()} (${now.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz })}, time zone ${tz}).\n` +
    (recent.length ? `Earlier in the conversation:\n${untrusted('SMS', recent.join('\n'))}\n` : '') +
    `New text message:\n${untrusted('SMS', formatMessage(m, names))}\n\n` +
    'Is the new message inviting the phone\'s owner to an event or get-together, or asking them to come, attend or meet ' +
    'somewhere at a future date or time? Not an errand or a message to pass on ("tell him to call Mom"), not their own ' +
    'plans, not something past, not a general question. Answer one JSON object: ' +
    '{"invite": true|false, "what": "a few words", "when": "local date-time as YYYY-MM-DDTHH:mm, or null if not said", ' +
    '"where": "place or null"}.',
    { maxTokens: 150, temperature: 0 });
  const raw = String(res?.content || '');
  let got;
  try { got = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return null; }
  if (!got?.invite || !got.what) return null;
  const when = got.when && Number.isFinite(Date.parse(got.when)) ? String(got.when) : null;
  return { what: String(got.what).slice(0, 120), when, where: got.where ? String(got.where).slice(0, 120) : null };
}

export function remember(inv) {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > TTL_MS) pending.delete(k);
  const id = now.toString(36) + Math.random().toString(36).slice(2, 5);
  pending.set(id, { ...inv, at: now });
  return id;
}

export const recall = (id) => pending.get(id) || null;

function whenText(when) {
  if (!when) return '';
  const d = new Date(when);
  return ` ${d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

/** What the owner's calendar holds around the invitation, as one sentence ('' when unknown). */
export async function calendarLine(agent, when) {
  const cal = agent?.apiManager?.getPlugin?.('calendar');
  if (!cal?.execute || !when) return '';
  try {
    const r = await cal.execute({ action: 'checkAvailability', date: when });
    if (!r?.success) return '';
    const start = new Date(when).getTime();
    const end = start + 2 * 3600 * 1000;
    const clash = (r.busyTimes || []).filter(b => new Date(b.start).getTime() < end && new Date(b.end).getTime() > start);
    if (!clash.length) return 'Your calendar is clear then.';
    return `You already have ${clash.slice(0, 2).map(b => `"${b.title || 'something'}" at ${new Date(b.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`).join(' and ')}.`;
  } catch {
    return '';
  }
}

/** The owner's notice and its Telegram buttons. */
export function notice({ id, mode, inv, from, declined, calLine }) {
  const what = `${from} invited you: ${inv.what}${whenText(inv.when)}${inv.where ? ` at ${inv.where}` : ''}.`;
  let text;
  if (declined) text = `📅 ${what} I declined politely for you.`;
  else if (mode === 'ask') text = `📅 ${what}${calLine ? ` ${calLine}` : ''} Want to go?`;
  else text = `📅 ${what} I'll leave it with you: nothing is sent unless you tap a button.`;
  const keyboard = declined
    ? [[{ text: '✅ Accept after all', callback_data: `inv:${id}:a` }]]
    : [[{ text: '✅ Accept', callback_data: `inv:${id}:a` }, { text: '❌ Decline', callback_data: `inv:${id}:d` }]];
  if (inv.when) keyboard.push([{ text: '📅 Add to my calendar', callback_data: `inv:${id}:c` }]);
  return { text, reply_markup: { inline_keyboard: keyboard } };
}

/** The line the auto-reply prompt gets for an invitation. */
export function replyRule(mode, inv, owner) {
  const about = `This message is an invitation (${inv.what}${whenText(inv.when)}). `;
  return mode === 'decline'
    ? `${about}Decline it politely and warmly for ${owner}, with no reason given. Do not add a "NOTE FOR OWNER" line.`
    : `${about}Reply only that you'll pass it on to ${owner}. Never accept or decline it, and never say whether they are ` +
      'free or likely to come. Do not add a "NOTE FOR OWNER" line.';
}

/** Run the owner's choice: a = accept, d = decline, c = add to calendar. Returns what to tell them. */
export async function answer(agent, hub, id, verb) {
  const inv = recall(id);
  if (!inv) return 'That invitation is too old or from before a restart, so I no longer have it. Tell me what to send instead.';
  const out = [];
  if (verb === 'a' || verb === 'd') {
    const owner = process.env.OWNER_NAME || 'the owner';
    const name = agent?.config?.name || process.env.AGENT_NAME || 'their assistant';
    const notes = await hub.ownerNotesFor?.(inv.title, { from: { name: inv.from } }).catch(() => '') || '';
    const res = await agent.providerManager.generateResponse(
      `You are ${name}, ${owner}'s assistant, texting ${inv.from} in "${inv.title}". ${owner} ${verb === 'a' ? 'accepts' : 'declines'} ` +
      `this invitation: ${inv.what}${whenText(inv.when)}${inv.where ? ` at ${inv.where}` : ''}.\n` +
      (notes ? `${owner}'s instructions for talking with this person (tone only):\n${notes}\n` : '') +
      `Write one short, friendly text saying so for ${owner} (you are their assistant, not them). ` +
      (verb === 'd' ? 'Give no reason. ' : '') + 'Text only.',
      { maxTokens: 120, temperature: 0.5 });
    const text = String(res?.content || '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
    if (!text) return 'I could not write the reply. Try again, or tell me what to send.';
    const r = await hub.callTool('send_sms', { thread_id: inv.threadId, text, requested_by_owner: true },
      { deviceId: inv.deviceId, onlyDevice: inv.deviceId });
    out.push(!r?.ok ? `The phone did not take the reply (${r?.error?.message || 'no answer'}).`
      : r.pending ? `"${text}" is on your phone for you to tap Send.` : `Sent to ${inv.from}: "${text}"`);
  }
  if ((verb === 'a' || verb === 'c') && inv.when) {
    const cal = agent?.apiManager?.getPlugin?.('calendar');
    const start = new Date(inv.when);
    const r = cal?.execute ? await cal.execute({
      action: 'createEvent', title: inv.what, start: start.toISOString(),
      end: new Date(start.getTime() + 2 * 3600 * 1000).toISOString(),
      location: inv.where || '', description: `Invitation from ${inv.from}`, reminders: [{ minutes: 60 }]
    }).catch(e => ({ success: false, error: e.message })) : { success: false, error: 'no calendar' };
    out.push(r?.success ? `📅 Added to your calendar, with a reminder an hour before.` : `Could not add it to the calendar: ${r?.error || 'unknown error'}.`);
  }
  if (verb !== 'c') pending.delete(id);
  return out.join('\n') || 'Done.';
}
