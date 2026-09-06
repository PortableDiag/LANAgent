/**
 * The two scheduling statics this PR adds.
 *
 * The shipped test used a default import from a module whose only export is the
 * named `CalendarEvent`, so node refused to load it, and it targeted
 * `convertTimesForAttendee` — a pre-existing method this PR does not touch.
 *
 * `suggestAvailableSlots` is pure date arithmetic once the event list is in hand,
 * so it can be tested for real by stubbing `findByDateRange`. That is the half
 * worth pinning: an off-by-one in the gap maths double-books a calendar.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CalendarEvent } from '../../src/models/CalendarEvent.js';

const at = iso => new Date(iso);
const DAY_START = at('2026-09-07T09:00:00Z');
const DAY_END = at('2026-09-07T17:00:00Z');

// findByDateRange returns a mongoose query that resolves to documents; the static
// only reads startDate/endDate off each, so plain objects are a faithful stand-in.
const withEvents = (events) => {
  const original = CalendarEvent.findByDateRange;
  CalendarEvent.findByDateRange = async () => events.map(e => ({ ...e }));
  return () => { CalendarEvent.findByDateRange = original; };
};

const captureFind = () => {
  const calls = [];
  const original = CalendarEvent.find;
  CalendarEvent.find = (query) => {
    calls.push(query);
    return { sort: () => calls };
  };
  return { calls, restore: () => { CalendarEvent.find = original; } };
};

const busy = (startIso, endIso) => ({ startDate: at(startIso), endDate: at(endIso) });
const hhmm = d => d.toISOString().slice(11, 16);

test('findConflictingEvents covers all three overlap shapes', (t) => {
  const cap = captureFind();
  t.after(cap.restore);

  CalendarEvent.findConflictingEvents(DAY_START, DAY_END);
  const q = cap.calls[0];

  assert.equal(q.$or.length, 3, 'starts-within, ends-within and spans-the-range');
  assert.deepEqual(q.$or[0], { startDate: { $gte: DAY_START, $lt: DAY_END } });
  assert.deepEqual(q.$or[1], { endDate: { $gt: DAY_START, $lte: DAY_END } });
  assert.deepEqual(q.$or[2], { startDate: { $lte: DAY_START }, endDate: { $gte: DAY_END } });
});

test('findConflictingEvents ignores cancelled events', (t) => {
  const cap = captureFind();
  t.after(cap.restore);

  CalendarEvent.findConflictingEvents(DAY_START, DAY_END);
  assert.deepEqual(cap.calls[0].status, { $ne: 'cancelled' },
    "a cancelled event does not occupy its slot ('cancelled' is in the schema enum)");
});

test('findConflictingEvents can exclude the event being edited', (t) => {
  const cap = captureFind();
  t.after(cap.restore);

  CalendarEvent.findConflictingEvents(DAY_START, DAY_END);
  assert.equal('_id' in cap.calls[0], false, 'no exclusion unless one is asked for');

  CalendarEvent.findConflictingEvents(DAY_START, DAY_END, 'abc123');
  assert.deepEqual(cap.calls[1]._id, { $ne: 'abc123' },
    'editing an event must not report the event conflicting with itself');
});

test('suggestAvailableSlots refuses a non-positive duration', async (t) => {
  t.after(withEvents([]));

  await assert.rejects(() => CalendarEvent.suggestAvailableSlots(DAY_START, DAY_END, 0),
    /Duration must be greater than zero/);
  await assert.rejects(() => CalendarEvent.suggestAvailableSlots(DAY_START, DAY_END, -30),
    /Duration must be greater than zero/);
});

test('an empty calendar offers the start of the range', async (t) => {
  t.after(withEvents([]));

  const slots = await CalendarEvent.suggestAvailableSlots(DAY_START, DAY_END, 60);

  assert.equal(slots.length, 1);
  assert.equal(hhmm(slots[0].startDate), '09:00');
  assert.equal(hhmm(slots[0].endDate), '10:00', 'the slot is exactly the requested duration');
});

test('a gap between two meetings is offered', async (t) => {
  t.after(withEvents([
    busy('2026-09-07T09:00:00Z', '2026-09-07T10:00:00Z'),
    busy('2026-09-07T13:00:00Z', '2026-09-07T14:00:00Z')
  ]));

  const slots = await CalendarEvent.suggestAvailableSlots(DAY_START, DAY_END, 60);

  assert.equal(hhmm(slots[0].startDate), '10:00', 'first free moment is when the 09:00 ends');
  assert.equal(hhmm(slots[1].startDate), '14:00', 'and again after the 13:00');
});

test('a gap shorter than the requested duration is not offered', async (t) => {
  t.after(withEvents([
    busy('2026-09-07T09:00:00Z', '2026-09-07T10:00:00Z'),
    busy('2026-09-07T10:30:00Z', '2026-09-07T17:00:00Z')
  ]));

  const slots = await CalendarEvent.suggestAvailableSlots(DAY_START, DAY_END, 60);

  assert.deepEqual(slots, [], 'a 30-minute hole cannot hold a 60-minute meeting');
});

test('a fully booked range offers nothing', async (t) => {
  t.after(withEvents([busy('2026-09-07T09:00:00Z', '2026-09-07T17:00:00Z')]));

  assert.deepEqual(await CalendarEvent.suggestAvailableSlots(DAY_START, DAY_END, 30), []);
});

test('overlapping meetings do not rewind the cursor', async (t) => {
  // The second event ends before the first does; currentStart must not move back.
  t.after(withEvents([
    busy('2026-09-07T09:00:00Z', '2026-09-07T12:00:00Z'),
    busy('2026-09-07T10:00:00Z', '2026-09-07T11:00:00Z')
  ]));

  const slots = await CalendarEvent.suggestAvailableSlots(DAY_START, DAY_END, 60);

  assert.equal(slots.length, 1);
  assert.equal(hhmm(slots[0].startDate), '12:00',
    'the cursor must sit after the latest end, not the last one iterated');
});

test('a buffer keeps the slot clear of the surrounding meeting', async (t) => {
  t.after(withEvents([busy('2026-09-07T09:00:00Z', '2026-09-07T10:00:00Z')]));

  const withoutBuffer = await CalendarEvent.suggestAvailableSlots(DAY_START, DAY_END, 60, 0);
  const withBuffer = await CalendarEvent.suggestAvailableSlots(DAY_START, DAY_END, 60, 15);

  assert.equal(hhmm(withoutBuffer[0].startDate), '10:00');
  assert.equal(hhmm(withBuffer[0].startDate), '10:15',
    'the buffer must push the slot past the end of the preceding meeting');
});
