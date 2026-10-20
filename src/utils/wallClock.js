/**
 * Wall-clock times as people say them. "Noon PST" in October means noon Pacific time (19:00Z),
 * not noon at UTC-8 (20:00Z): people say PST/EST all year. So a model reports the time as said
 * (no offset) and the zone named, and the conversion to an instant happens here (2026-10-20).
 */

// Standard, daylight and generic names all mean the region's local time.
const ZONES = [
  [/\b(?:PST|PDT|PT)\b|\bpacific(?: time)?\b/i, 'America/Los_Angeles'],
  [/\b(?:MST|MDT|MT)\b|\bmountain time\b/i, 'America/Denver'],
  [/\b(?:CST|CDT|CT)\b|\bcentral time\b/i, 'America/Chicago'],
  [/\b(?:EST|EDT|ET)\b|\beastern(?: time)?\b/i, 'America/New_York'],
  [/\b(?:AKST|AKDT)\b|\balaska time\b/i, 'America/Anchorage'],
  [/\bHST\b|\bhawaii time\b/i, 'Pacific/Honolulu'],
  [/\b(?:UTC|GMT)\b/i, 'UTC']
];

/** The zone the request names, or null. Abbreviations must be upper case ("et" is a word). */
export function zoneFromText(text) {
  const s = String(text || '');
  for (const [re, zone] of ZONES) {
    const m = s.match(re);
    if (m && (m[0].length > 4 || m[0] === m[0].toUpperCase())) return zone;
  }
  return null;
}

/** The agent's own zone (the owner's, on a home server). */
export function localZone() {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function offsetMs(instant, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(instant).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(instant / 1000) * 1000;
}

/** True when the string carries its own offset or Z. */
export function hasOffset(iso) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(iso || '').trim());
}

/**
 * "2026-10-20T12:00" in zone → Date. A string with its own offset is taken as it is.
 * Returns null when it cannot be read.
 */
export function wallTimeToDate(local, zone = localZone()) {
  const s = String(local || '').trim();
  if (!s) return null;
  if (hasOffset(s)) { const d = new Date(s); return Number.isFinite(d.getTime()) ? d : null; }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  let t = guess - offsetMs(guess, zone);
  t = guess - offsetMs(t, zone); // second pass lands right across a DST change
  return new Date(t);
}

/** "2026-10-20T11:43 (Tuesday) America/Los_Angeles" — the local now for a prompt. */
export function nowInZone(zone = localZone(), now = new Date()) {
  const local = new Date(now.getTime() + offsetMs(now.getTime(), zone)).toISOString().slice(0, 16);
  const day = now.toLocaleDateString('en-US', { timeZone: zone, weekday: 'long' });
  return `${local} (${day}) ${zone}`;
}

const NAMES_A_DAY = /\b(?:today|tonight|tomorrow|yesterday|mon|tues?|wed|thu(?:rs)?|fri|sat|sun)(?:day)?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d|\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\bnext\b/i;
const UNIT_MS = { minute: 6e4, min: 6e4, hour: 36e5, hr: 36e5, day: 864e5, week: 6048e5 };
const COUNT = { a: 1, an: 1, one: 1, two: 2, three: 3, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };

/** "in 5 minutes", "in an hour", "in half an hour" → milliseconds from now, or null. */
export function relativeMs(text) {
  const s = String(text || '').toLowerCase();
  if (/\bin half an? hour\b/.test(s)) return 18e5;
  const m = s.match(/\bin\s+(\d+(?:\.\d+)?|an?|one|two|three|five|ten|fifteen|twenty|thirty)\s*(minute|min|hour|hr|day|week)s?\b/);
  return m ? (COUNT[m[1]] ?? Number(m[1])) * UNIT_MS[m[2]] : null;
}

/**
 * A model's time for a request → Date, or null. Relative times ("in 5 minutes") are counted from
 * now; a wall-clock time is read in the zone the request names, else the local zone. When the
 * value is unreadable, a relative time in the request itself is used ("at": "in 5 minutes" came
 * through as text and the schedule was refused, 2026-10-20).
 */
export function resolveRequestTime(value, requestText, now = Date.now()) {
  const rel = relativeMs(value);
  if (rel != null) return new Date(now + rel);
  const d = wallTimeToDate(value, zoneFromText(requestText) || localZone());
  // "At noon" asked at 12:20 is tomorrow's noon unless the request names a day.
  if (d && !hasOffset(value) && d.getTime() < now - 6e4 && requestText && !NAMES_A_DAY.test(requestText)) {
    return new Date(d.getTime() + 864e5);
  }
  if (d) return d;
  const fromRequest = relativeMs(requestText);
  return fromRequest != null ? new Date(now + fromRequest) : null;
}
