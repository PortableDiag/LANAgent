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
const NOT_NOW = /\b(at night|tonight|tomorrow|morning|evening|every|daily|schedule|timer|in \d+\s*(min|minute|hour|second|sec)s?|at \d{1,2}(:\d{2})?\s*(am|pm)?|when|until|if|after|before)\b/i;
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

/** What to do with the light: one action, or null when there is none or more than one. */
export function findSetting(text, colorNames = []) {
  const t = String(text).toLowerCase();
  const found = [];
  const pct = t.match(/\b(\d{1,3})\s*(%|percent)/);
  if (pct) found.push({ action: 'brightness', params: { level: Math.max(1, Math.min(100, parseInt(pct[1], 10))) } });
  else if (/\b(full brightness|brightest|max(imum)? brightness)\b/.test(t)) found.push({ action: 'brightness', params: { level: 100 } });
  else if (/\b(dim it|dim the|dimmer|dim)\b/.test(t) && !/\bwhite\b/.test(t)) found.push({ action: 'brightness', params: { level: 20 } });

  const kelvin = t.match(/\b(\d{4})\s*k(elvin)?\b/);
  const white = WHITES.find(w => t.includes(w));
  if (kelvin) found.push({ action: 'temperature', params: { kelvin: Math.max(2000, Math.min(9000, parseInt(kelvin[1], 10))) } });
  else if (white) found.push({ action: 'color', params: { color: white } });
  else {
    const color = colorNames.filter(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)).sort((a, b) => b.length - a.length)[0];
    if (color && !(color === 'light' || color === 'off')) found.push({ action: 'color', params: { color } });
  }

  const off = /\b(turn|switch|shut|put|flip|kill)\b[^.!?]*\boff\b|\boff\s*[.!]*$|\blights? out\b/.test(t);
  const on = /\b(turn|switch|put|flip)\b[^.!?]*\bon\b|\bon\s*[.!]*$/.test(t);
  if (off && !found.length) return on ? null : { action: 'power', params: { state: 'off' } };
  if (on && !found.length) return { action: 'power', params: { state: 'on' } };
  if (off) return null; // "off" with a colour: unclear
  return found.length === 1 ? found[0] : null;
}

/** { device, action, params } for a plain one-light, one-setting command, else null. */
export function parseLightCommand(text, deviceNames, colorNames = []) {
  if (!text || !deviceNames?.length) return null;
  const s = String(text).trim();
  if (s.length > 160 || QUESTION.test(s) || NOT_NOW.test(s)) return null;
  if (/\b(and then|then|also)\b/i.test(s)) return null;
  const device = findDevice(s, deviceNames);
  if (!device) return null;
  const setting = findSetting(s, colorNames);
  if (!setting) return null;
  return { device, action: setting.action, params: { device, ...setting.params } };
}
