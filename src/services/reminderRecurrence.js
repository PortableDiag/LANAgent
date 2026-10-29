/**
 * Repeating reminders ("remind me monthly to clean the vacuum bags"). A repeating reminder is a
 * chain of one-off Agenda 'reminder' jobs: each run schedules the next occurrence, so it can be
 * listed and cancelled like any reminder, and a monthly one keeps its day of the month (the 31st
 * falls on the last day of a shorter month, then returns to the 31st).
 *
 * The anchor is the intended day and time of day, which is not always the first run: "starting
 * today" at 10:40 with the default 9:00 sends today's at once and the rest at 9:00.
 */

export const REPEATS = ['daily', 'weekly', 'monthly', 'yearly'];
const DEFAULT_HOUR = 9;

const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();

/** 'every month' / 'Monthly' / 'month' → 'monthly'; anything else → null. */
export function normalizeRepeat(v) {
  const s = String(v || '').toLowerCase().trim();
  if (!s) return null;
  if (/^(daily|day|every ?day)$/.test(s)) return 'daily';
  if (/^(weekly|week|every ?week)$/.test(s)) return 'weekly';
  if (/^(monthly|month|every ?month)$/.test(s)) return 'monthly';
  if (/^(yearly|annually|annual|year|every ?year)$/.test(s)) return 'yearly';
  return null;
}

/** The repeat a sentence asks for, or null for a one-off. */
export function repeatFromText(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(monthly|every month|each month|once a month|every (\d+(st|nd|rd|th)|first|last) of (the|each|every) month)\b/.test(t)) return 'monthly';
  if (/\b(weekly|every week|each week|once a week|every (mon|tues|wednes|thurs|fri|satur|sun)day)\b/.test(t)) return 'weekly';
  if (/\b(daily|every day|each day|once a day|every (morning|evening|night))\b/.test(t)) return 'daily';
  if (/\b(yearly|annually|every year|each year|once a year)\b/.test(t)) return 'yearly';
  return null;
}

/** Hour and minute from "at 9am", "9:30 pm", "at 14:00"; null when none is given. */
export function timeFromText(text) {
  const m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s|$|[,.!?])/i.exec(String(text || '').replace(/\b\d{1,2}(st|nd|rd|th)\b/gi, ' '));
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (!ap && !m[2] && !/\bat\s+\d/i.test(m[0])) return null; // a bare number is not a time
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { hour: h, minute: min };
}

/**
 * The intended first day and time: an explicit ISO start wins; else "tomorrow" or today, at the
 * time named in the text or 9:00.
 */
export function resolveAnchor({ startAt, text, now = new Date() } = {}) {
  if (startAt) {
    const d = new Date(startAt);
    if (!Number.isNaN(d.getTime()) && /\d{4}-\d\d-\d\d/.test(String(startAt))) return d;
  }
  const src = `${startAt || ''} ${text || ''}`;
  const d = new Date(now);
  if (/\btomorrow\b/i.test(src)) d.setDate(d.getDate() + 1);
  const t = timeFromText(src) || { hour: DEFAULT_HOUR, minute: 0 };
  d.setHours(t.hour, t.minute, 0, 0);
  return d;
}

export function anchorOf(date) {
  return { day: date.getDate(), weekday: date.getDay(), month: date.getMonth(), hour: date.getHours(), minute: date.getMinutes() };
}

/** The first occurrence of the repeat strictly after `from`, at the anchor's day and time. */
export function nextOccurrence(from, repeat, anchor) {
  const f = new Date(from);
  const at = (y, m, d) => new Date(y, m, d, anchor.hour, anchor.minute, 0, 0);
  if (repeat === 'daily') {
    let c = at(f.getFullYear(), f.getMonth(), f.getDate());
    if (c <= f) c = at(f.getFullYear(), f.getMonth(), f.getDate() + 1);
    return c;
  }
  if (repeat === 'weekly') {
    const ahead = (anchor.weekday - f.getDay() + 7) % 7;
    let c = at(f.getFullYear(), f.getMonth(), f.getDate() + ahead);
    if (c <= f) c = at(f.getFullYear(), f.getMonth(), f.getDate() + ahead + 7);
    return c;
  }
  if (repeat === 'monthly') {
    for (let i = 0; i < 3; i++) {
      const y = f.getFullYear() + Math.floor((f.getMonth() + i) / 12);
      const m = (f.getMonth() + i) % 12;
      const c = at(y, m, Math.min(anchor.day, daysIn(y, m)));
      if (c > f) return c;
    }
  }
  if (repeat === 'yearly') {
    for (let i = 0; i < 3; i++) {
      const y = f.getFullYear() + i;
      const c = at(y, anchor.month, Math.min(anchor.day, daysIn(y, anchor.month)));
      if (c > f) return c;
    }
  }
  throw new Error(`Unknown repeat: ${repeat}`);
}

/** When the first reminder goes out: the anchor, or in a minute when the anchor is earlier today. */
export function firstRun(anchorAt, repeat, now = new Date()) {
  if (anchorAt > now) return anchorAt;
  const sameDay = anchorAt.toDateString() === now.toDateString();
  return sameDay ? new Date(now.getTime() + 60 * 1000) : nextOccurrence(now, repeat, anchorOf(anchorAt));
}

/** "on the 29th of each month at 9:00 AM" */
export function describeRepeat(repeat, anchor) {
  const time = new Date(2000, 0, 1, anchor.hour, anchor.minute).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  if (repeat === 'daily') return `every day at ${time}`;
  if (repeat === 'weekly') return `every ${new Date(2000, 0, 2 + anchor.weekday).toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`;
  if (repeat === 'monthly') return `on the ${ord(anchor.day)} of each month at ${time}${anchor.day > 28 ? ' (the last day in shorter months)' : ''}`;
  return `every ${new Date(2000, anchor.month, 1).toLocaleDateString('en-US', { month: 'long' })} ${anchor.day} at ${time}`;
}
