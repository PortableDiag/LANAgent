/**
 * Plain light commands read without a model: "make the Master Toilet light bright white", "turn off the TV bars",
 * "set the toilet light to 30%". The owner's real device names come from Govee, so the device is never guessed.
 *
 * 2026-11-09: the same sentence spent 57 s and 80 s in two model round-trips before anything was sent to the light,
 * and a follow-up was routed to device "waiting". Anything this cannot read for sure (a schedule, a question, two
 * devices, two settings) returns null and goes to the model as before.
 */

const GENERIC = new Set(['light', 'lights', 'lamp', 'lamps', 'bulb', 'bulbs', 'the', 'my', 'led', 'strip', 'strips', 'smart']);
const WHITES = ['bright white', 'warm white', 'cool white', 'cold white', 'soft white', 'neutral white', 'daylight'];
const NOT_NOW = /\b(at night|tonight|tomorrow|morning|evening|every|daily|schedule|timer|in \d+\s*(min|minute|hour|second|sec)s?|at \d{1,2}(?!\d|\s*(?:%|percent))(:\d{2})?\s*(am|pm)?|when|until|if|after|before)\b/i;
const QUESTION = /\?\s*$|^(alice[, ]+)?(what|which|is|are|why|how|does|do|did|can you tell|tell me)\b/i;

const words = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];

/** The one device the text names: the whole name, else the only device whose distinctive word appears. */
export function findDevice(text, names) {
  const t = ` ${words(text).join(' ')} `;
  if (/\ball (the )?(lights|devices)\b|\bevery light\b|\beverything\b/.test(t)) return 'all';
  const full = names.filter(n => words(n).length && t.includes(` ${words(n).join(' ')} `));
  if (full.length) {
    const longest = full.sort((a, b) => b.length - a.length);
    // Two different devices named in full ("living room left and living room right") is not one command.
    return longest.filter(n => !words(longest[0]).join(' ').includes(words(n).join(' '))).length ? null : longest[0];
  }
  const tw = new Set(words(text));
  const hits = names.filter(n => words(n).some(w => w.length >= 4 && !GENERIC.has(w) && tw.has(w)));
  return hits.length === 1 ? hits[0] : null;
}

/** Whether the text names a distinctive word of a device other than `except`. */
function mentionsOther(text, names, except) {
  const tw = new Set(words(text));
  return names.some(n => n !== except && words(n).some(w => w.length >= 4 && !GENERIC.has(w) && tw.has(w)));
}

/** Colours picked from when the owner leaves the choice to the agent, soft ones first. */
const PICKS = ['amber', 'purple', 'gold', 'indigo', 'turquoise', 'orange', 'magenta', 'pink', 'violet', 'blue', 'cyan', 'green', 'red'];
const NOT_THIS = /\b(?:other than|besides|except(?: for)?|anything but|but not|instead of|rather than|no more|not)\s+(?:a\s+|the\s+|just\s+)?/;

/**
 * What to do with the light: one action (a colour may carry a brightness), or null when there is none or more than one.
 * "A nice dim color other than White" set white (2026-11-25): a colour ruled out is never the one set, and a colour left
 * to the agent is picked, never the one it picked last.
 */
export function findSetting(text, colorNames = [], { avoid = null, random = Math.random } = {}) {
  let t = String(text).toLowerCase();
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const all = [...new Set([...WHITES, 'white', ...colorNames.map(c => String(c).toLowerCase())])].sort((a, b) => b.length - a.length);
  const out = [];
  const ruled = new RegExp(`${NOT_THIS.source}(${all.map(esc).join('|')})\\b(?:\\s*(?:,|or|and|nor)\\s*(?:${all.map(esc).join('|')})\\b)*`, 'g');
  t = t.replace(ruled, (m) => { for (const c of all) if (new RegExp(`\\b${esc(c)}\\b`).test(m)) out.push(c); return ' '; });
  const open = out.length > 0 || /\b(?:a|an|some|another|any|different|other|random|new|nice|pretty|cool|fun|soft)\b[^.!?]{0,25}\bcolou?rs?\b|\b(?:pick|choose|change|switch)\b[^.!?]{0,25}\bcolou?r\b/.test(t);
  const found = [];
  const pct = t.match(/\b(\d{1,3})\s*(%|percent)/);
  if (pct) found.push({ action: 'brightness', params: { level: Math.max(1, Math.min(100, parseInt(pct[1], 10))) } });
  else if (/\b(full brightness|brightest|max(imum)? brightness)\b/.test(t)) found.push({ action: 'brightness', params: { level: 100 } });
  else if (/\b(dim it|dim the|dimmer|dim)\b/.test(t)) found.push({ action: 'brightness', params: { level: 20 } });

  const kelvin = t.match(/\b(\d{4})\s*k(elvin)?\b/);
  const white = WHITES.find(w => t.includes(w));
  if (kelvin) found.push({ action: 'temperature', params: { kelvin: Math.max(2000, Math.min(9000, parseInt(kelvin[1], 10))) } });
  else if (white) found.push({ action: 'color', params: { color: white } });
  else {
    const color = colorNames.filter(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)).sort((a, b) => b.length - a.length)[0];
    if (color && !(color === 'light' || color === 'off')) found.push({ action: 'color', params: { color } });
    else if (open) {
      const can = PICKS.filter(c => colorNames.some(n => String(n).toLowerCase() === c) && !out.includes(c));
      const fresh = can.filter(c => c !== avoid);
      const from = (fresh.length ? fresh : can).slice(0, 6);
      if (from.length) found.push({ action: 'color', params: { color: from[Math.floor(random() * from.length)] } });
    }
  }
  // "A dim red", "blue at 30%": one colour and how bright, sent together.
  if (found.length === 2 && found[0].action === 'brightness') return { action: found[1].action, params: { ...found[1].params, alsoBrightness: found[0].params.level } };

  const off = /\b(turn|switch|shut|put|flip|kill)\b[^.!?]*\boff\b|\boff\s*[.!]*$|\blights? out\b/.test(t);
  const on = /\b(turn|switch|put|flip)\b[^.!?]*\bon\b|\bon\s*[.!]*$/.test(t);
  if (off && !found.length) return on ? null : { action: 'power', params: { state: 'off' } };
  if (on && !found.length) return { action: 'power', params: { state: 'on' } };
  if (off) return null; // "off" with a colour: unclear
  return found.length === 1 ? found[0] : null;
}

/** { device, action, params } for a plain one-light, one-setting command, else null. */
export function parseLightCommand(text, deviceNames, colorNames = [], { recentDevice = null, recentColor = null } = {}) {
  if (!text || !deviceNames?.length) return null;
  const s = String(text).trim();
  if (s.length > 160 || QUESTION.test(s) || NOT_NOW.test(s)) return null;
  if (/\b(and then|then|also)\b/i.test(s)) return null;
  // "Turn the bathroom light on" right after a Master Toilet command: no device is named, so it is that one
  // (2026-11-11: it became device "second time to turn the fucking bathroom", the thermometer).
  const device = findDevice(s, deviceNames) || (recentDevice && /\b(light|lights|lamp|bulb|it|colou?rs?)\b/i.test(s) && !mentionsOther(s, deviceNames, recentDevice) ? recentDevice : null);
  if (!device) return null;
  const setting = findSetting(s, colorNames, { avoid: recentColor });
  if (!setting) return null;
  return { device, action: setting.action, params: { device, ...setting.params } };
}

/**
 * A complaint or a "do it again" about the light just changed: "no, it didn't, I'm sitting in the dark, fix the light",
 * "make the damn light bright white already", "try again". It repeats the last light command (2026-11-10: the first
 * went to plain chat, which replied with a fake action tag; the second became device "damn like").
 */
const COMPLAINT = /\b(didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|not)\b[^.!?]{0,30}\b(work|working|on|change|changed|happen|happened|come on|turn on)\b|\bstill (dark|off|not|nothing|the same)\b|\bin the dark\b|\bfix (the |my |that |this )?(damn |fucking |stupid )?(light|lights|lamp|it)\b|\b(try|do) (it |that )?again\b|\bretry\b|\balready\b|\bhurry\b|\bnothing happened\b/i;

/** "Do it now", "Lies", "now!": short pushes right after a light command mean do it again (2026-11-11). */
const PUSH = /^\s*(alice[,\s]+)?((just )?do it( now| already)?|now( now)*|right now|lies?|liar|you lied|that'?s a lie|bullshit|wrong|nope|no it'?s not|it'?s (still )?not( on| done| white)?|not done)[\s.!]*$/i;

/** "Prove it", "is it on?", "did it work?": read the light back and say what it shows. */
export function isLightCheck(text) {
  return /^\s*(alice[,\s]+)?(prove it|show me|check (it|the light)|is it (on|done|working|white)|did it (work|change|go through)|what (is|does) (it|the light) (show|showing|set to|at))\b[\s?.!]*$/i.test(String(text || ''));
}

export function isLightComplaint(text) {
  if (PUSH.test(String(text || ''))) return true;
  const s = String(text || '').trim();
  if (!s || s.length > 200 || /\?\s*$/.test(s) && !/\bwhy\b/i.test(s) && !COMPLAINT.test(s)) return false;
  // "Why did I have to ask 3 times" is a question about it, not a request to do it again.
  if (/^\s*(why|how come|what)\b/i.test(s)) return false;
  return COMPLAINT.test(s);
}

/**
 * A question about the lights' schedules: { device } (null: all of them), or null when it is not one. "Do you have any
 * schedules for that light?" took 30 s and was answered from the chat, not from the schedules (2026-11-25).
 */
export function scheduleQuestion(text, deviceNames = [], recentDevice = null) {
  const s = String(text || '').trim();
  if (s.length > 160 || !/\bschedul(?:e|es|ed)\b/i.test(s)) return null;
  if (/\b(?:delete|cancel|remove|clear|add|create|set up|make|change|move|stop|turn|update|disable|enable|meeting|email|calendar|post|task|reminder|job|call)\b/i.test(s)) return null;
  if (!/\?\s*$/.test(s) && !/^(?:alice[, ]+)?(?:do|does|are|is|what|which|any|list|show|check|when)\b/i.test(s)) return null;
  const device = findDevice(s, deviceNames);
  if (device && device !== 'all') return { device };
  if (!/\b(?:lights?|lamps?|bulbs?|govee)\b/i.test(s)) return null;
  if (recentDevice && /\b(?:that|this|the) (?:light|lamp|bulb)\b/i.test(s)) return { device: recentDevice };
  return { device: null };
}

/** The schedules as listSchedules gives them, in words. */
export function schedulesInWords(schedules, device = null) {
  const list = (schedules || []).filter(x => !x.disabled);
  if (!list.length) return device ? `There is no schedule for ${device}.` : 'There are no light schedules.';
  const does = (x) => x.action === 'power' ? `turns ${x.settings?.state || 'on'}` : x.settings?.color ? `set to ${x.settings.color}` : x.settings?.level ? `set to ${x.settings.level}%` : x.settings?.kelvin ? `set to ${x.settings.kelvin}K white` : x.settings?.scene ? `scene ${x.settings.scene}` : x.action;
  return `${list.length === 1 ? 'One schedule' : `${list.length} schedules`}:\n${list.map(x => `- ${x.deviceName}: ${does(x)}, ${x.when}`).join('\n')}`;
}
