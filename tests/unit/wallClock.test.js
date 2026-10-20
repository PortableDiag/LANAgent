/**
 * "Noon PST" in October is noon Pacific time (19:00Z), not 20:00Z: a scheduled email meant for
 * noon was set for 1 PM (2026-10-20).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneFromText, wallTimeToDate, resolveRequestTime, nowInZone, hasOffset } from '../../src/utils/wallClock.js';

test('PST, PDT and PT all mean Pacific local time', () => {
  for (const t of ['at noon PST', 'at noon PDT', 'noon PT', 'noon pacific time']) assert.equal(zoneFromText(t), 'America/Los_Angeles', t);
  assert.equal(zoneFromText('9am EST'), 'America/New_York');
  assert.equal(zoneFromText('let me know'), null);
  assert.equal(zoneFromText('I bet it works'), null);   // "et" is a word, not Eastern time
});

test('noon PST during daylight time is 19:00Z, in winter 20:00Z', () => {
  assert.equal(resolveRequestTime('2026-10-20T12:00', 'Send Sam a message at noon PST', Date.parse('2026-10-01T00:00:00Z')).toISOString(), '2026-10-20T19:00:00.000Z');
  assert.equal(resolveRequestTime('2026-12-01T12:00', 'noon PST', Date.parse('2026-10-01T00:00:00Z')).toISOString(), '2026-12-01T20:00:00.000Z');
  assert.equal(resolveRequestTime('2026-10-20T09:00', 'at 9 EST', Date.parse('2026-10-01T00:00:00Z')).toISOString(), '2026-10-20T13:00:00.000Z');
});

test('across the DST change', () => {
  assert.equal(wallTimeToDate('2026-03-08T01:30', 'America/Los_Angeles').toISOString(), '2026-03-08T09:30:00.000Z');
  assert.equal(wallTimeToDate('2026-03-08T03:30', 'America/Los_Angeles').toISOString(), '2026-03-08T10:30:00.000Z');
  assert.equal(wallTimeToDate('2026-11-01T12:00', 'America/Los_Angeles').toISOString(), '2026-11-01T20:00:00.000Z');
});

test('no zone named: the local zone; an explicit offset is kept', () => {
  process.env.TZ = 'America/Los_Angeles';
  assert.equal(resolveRequestTime('2026-10-20T12:00', 'text Sam at noon', Date.parse('2026-10-01T00:00:00Z')).toISOString(), '2026-10-20T19:00:00.000Z');
  assert.equal(resolveRequestTime('2026-10-20T12:00:00Z', 'noon PST').toISOString(), '2026-10-20T12:00:00.000Z');
  assert.ok(hasOffset('2026-10-20T12:00-07:00'));
  assert.equal(resolveRequestTime('soon', 'x'), null);
});

test('nowInZone gives local wall time and the zone', () => {
  assert.equal(nowInZone('America/Los_Angeles', new Date('2026-10-20T18:43:00Z')), '2026-10-20T11:43 (Tuesday) America/Los_Angeles');
});

test('relative times are counted from now', () => {
  const now = Date.parse('2026-10-20T19:16:44Z');
  assert.equal(resolveRequestTime('in 5 minutes', 'Send Sam a message in 5 minutes', now).toISOString(), '2026-10-20T19:21:44.000Z');
  assert.equal(resolveRequestTime('in an hour', '', now).toISOString(), '2026-10-20T20:16:44.000Z');
  assert.equal(resolveRequestTime('in half an hour', '', now).toISOString(), '2026-10-20T19:46:44.000Z');
  assert.equal(resolveRequestTime('soon-ish', 'text Sam in 10 min', now).toISOString(), '2026-10-20T19:26:44.000Z');
});

test('a past time with no day named means tomorrow', () => {
  process.env.TZ = 'America/Los_Angeles';
  const now = Date.parse('2026-10-20T19:24:00Z'); // 12:24 PT
  assert.equal(resolveRequestTime('2026-10-20T12:00', 'text Sam at noon PST', now).toISOString(), '2026-10-21T19:00:00.000Z');
  assert.equal(resolveRequestTime('2026-10-20T12:00', 'text Sam today at noon', now).toISOString(), '2026-10-20T19:00:00.000Z');
  assert.equal(resolveRequestTime('2026-10-20T15:00', 'text Sam at 3pm', now).toISOString(), '2026-10-20T22:00:00.000Z');
  assert.equal(resolveRequestTime('2026-10-20T12:00:00Z', 'at noon', now).toISOString(), '2026-10-20T12:00:00.000Z');
});
