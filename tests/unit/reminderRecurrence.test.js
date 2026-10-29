/**
 * Repeating reminders: the repeat read from a request, the anchor day/time, and the next occurrence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepeat, repeatFromText, timeFromText, resolveAnchor, anchorOf, nextOccurrence, firstRun } from '../../src/services/reminderRecurrence.js';

test('the repeat comes from the parameter or the sentence', () => {
  assert.equal(normalizeRepeat('Monthly'), 'monthly');
  assert.equal(normalizeRepeat('every week'), 'weekly');
  assert.equal(normalizeRepeat('soon'), null);
  assert.equal(repeatFromText('remind me monthly starting today to clean the vacuum bags'), 'monthly');
  assert.equal(repeatFromText('remind me every Friday to call mom'), 'weekly');
  assert.equal(repeatFromText('remind me to stretch in 20 minutes'), null);
});

test('times are read only when they are times', () => {
  assert.deepEqual(timeFromText('at 7pm'), { hour: 19, minute: 0 });
  assert.deepEqual(timeFromText('every day 9:30 am'), { hour: 9, minute: 30 });
  assert.equal(timeFromText('on the 15th of each month'), null);
  assert.equal(timeFromText('clean 2 vacuum bags'), null);
});

test('the anchor defaults to 9:00 today, or tomorrow when asked', () => {
  const now = new Date(2026, 9, 29, 10, 40);
  const a = resolveAnchor({ text: 'monthly starting today', now });
  assert.equal(a.getDate(), 29); assert.equal(a.getHours(), 9);
  assert.equal(resolveAnchor({ text: 'starting tomorrow at 8pm', now }).getDate(), 30);
});

test('a monthly reminder keeps its day, falling back to the last day of short months', () => {
  const anchor = anchorOf(new Date(2026, 0, 31, 9, 0));
  let d = new Date(2026, 0, 31, 10, 0);
  const days = [];
  for (let i = 0; i < 3; i++) { d = nextOccurrence(d, 'monthly', anchor); days.push(`${d.getMonth() + 1}/${d.getDate()}`); }
  assert.deepEqual(days, ['2/28', '3/31', '4/30']);
});

test('weekly, daily and yearly occurrences are strictly after the run', () => {
  const thu = new Date(2026, 9, 29, 19, 0);
  assert.equal(nextOccurrence(thu, 'weekly', anchorOf(thu)).getDate(), 5);
  assert.equal(nextOccurrence(thu, 'daily', anchorOf(thu)).getDate(), 30);
  const leap = anchorOf(new Date(2028, 1, 29, 9, 0));
  assert.equal(nextOccurrence(new Date(2028, 1, 29, 10), 'yearly', leap).getDate(), 28);
});

test('"starting today" after the anchor time sends the first one now, not next month', () => {
  const now = new Date(2026, 9, 29, 10, 40);
  const anchorAt = new Date(2026, 9, 29, 9, 0);
  assert.ok(firstRun(anchorAt, 'monthly', now) - now <= 60 * 1000);
  const later = new Date(2026, 9, 29, 18, 0);
  assert.equal(firstRun(later, 'monthly', now).getTime(), later.getTime());
});
