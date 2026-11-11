/**
 * A repeating light command read without a model: "Every morning at 7am make the Master Toilet light bright white",
 * "every weekday at 6:30 turn on the kitchen bar 1", "every night at 11 pm turn off the TV bars".
 *
 * 2026-11-11: schedules were saved by a throwaway Agenda into a collection nothing processes, so no Govee schedule had
 * ever fired. The light part is read by parseLightCommand, so the device is one of the owner's real ones or nothing.
 */
import { parseLightCommand } from './lightCommand.js';

const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const WHEN = /\b(every\s*(day|morning|night|evening|afternoon|weekday|weekend|(sun|mon|tues|wednes|thurs|fri|satur)day)s?|daily|each\s+(day|morning|night|evening)|(every\s+)?weekdays|(every\s+)?weekends|on\s+weekdays|on\s+weekends)\b/i;

/** { minute, hour } from "7am", "7:30 pm", "19:00", "at 7" (+ "morning"/"night" to place a bare hour). */
export function readTime(text) {
  const s = String(text);
  const at = s.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i) || s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i) || s.match(/\b(\d{1,2}):(\d{2})\b()/);
  if (!at) return null;
  let hour = parseInt(at[1], 10);
  const minute = at[2] ? parseInt(at[2], 10) : 0;
  const ap = (at[3] || '').toLowerCase().replace(/\./g, '');
  if (hour > 23 || minute > 59) return null;
  if (ap === 'pm' && hour < 12) hour += 12;
  else if (ap === 'am' && hour === 12) hour = 0;
  else if (!ap && hour <= 12 && /\b(night|evening|afternoon)\b/i.test(s) && hour < 12) hour += 12;
  return { hour, minute, matched: at[0] };
}

/** The cron day-of-week field and a plain label. */
export function readDays(text) {
  const t = String(text).toLowerCase();
  if (/weekday/.test(t)) return { dow: '1-5', label: 'every weekday' };
  if (/weekend/.test(t)) return { dow: '0,6', label: 'every weekend day' };
  const named = Object.keys(DAYS).filter(d => new RegExp(`\\b${d}s?\\b`).test(t));
  if (named.length) return { dow: named.map(d => DAYS[d]).join(','), label: `every ${named.map(d => d[0].toUpperCase() + d.slice(1)).join(', ')}` };
  return { dow: '*', label: 'every day' };
}

/**
 * { device, action, params, cron, hour, minute, label } for a repeating one-light command, else null.
 */
export function parseLightSchedule(text, deviceNames, colorNames = []) {
  if (!text || !deviceNames?.length) return null;
  const s = String(text).trim();
  if (s.length > 200 || /\?\s*$/.test(s) || !WHEN.test(s)) return null;
  const time = readTime(s);
  if (!time) return null;
  const days = readDays(s);
  // What is left once the "when" is taken out is a plain light command.
  const rest = s.replace(WHEN, ' ').replace(time.matched, ' ').replace(/\b(in the|every|each|on)\s*$/i, ' ')
    .replace(/\b(in the\s+)?(morning|night|evening|afternoon)s?\b/gi, ' ').replace(/^\s*(alice[,\s]+)?(please\s+)?/i, '').replace(/\s+/g, ' ').trim();
  const light = parseLightCommand(rest, deviceNames, colorNames);
  if (!light) return null;
  return { ...light, hour: time.hour, minute: time.minute, cron: `${time.minute} ${time.hour} * * ${days.dow}`, label: days.label };
}

/** "7:00 AM" */
export function clock(hour, minute) {
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}
