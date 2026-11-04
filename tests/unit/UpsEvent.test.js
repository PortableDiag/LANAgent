import test from 'node:test';
import assert from 'node:assert/strict';
import { UpsEvent } from '../../src/models/UpsEvent.js';

const ev = (eventId, eventType, severity, iso, actionsTaken = []) => ({
  eventId, upsName: 'ups-a', eventType, severity, createdAt: new Date(iso), actionsTaken
});

async function timeline(events, options) {
  const originalFind = UpsEvent.find;
  let query;
  UpsEvent.find = (q) => {
    query = q;
    return { sort() { return this; }, limit() { return this; }, async lean() { return events; } };
  };
  try {
    return { incidents: await UpsEvent.buildIncidentTimeline(options), query };
  } finally {
    UpsEvent.find = originalFind;
  }
}

const HIST = { start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z' };

test('an outage with battery events resolves when mains returns', async () => {
  const { incidents, query } = await timeline([
    ev('ob', 'on_battery', 'warning', '2024-01-01T00:00:00Z', ['notification_sent']),
    ev('low', 'low_battery', 'warning', '2024-01-01T00:04:00Z'),
    ev('crit', 'battery_critical', 'critical', '2024-01-01T00:08:00Z', ['notification_sent', 'shutdown_initiated']),
    ev('ol', 'power_restored', 'info', '2024-01-01T00:10:00Z')
  ], { upsName: 'ups-a', ...HIST });

  assert.equal(query.upsName, 'ups-a');
  assert.equal(incidents.length, 1);
  const [i] = incidents;
  assert.equal(i.triggeringEvent.eventId, 'ob');
  assert.deepEqual(i.relatedEvents.map(e => e.eventId), ['low', 'crit', 'ol']);
  assert.equal(i.maximumSeverity, 'critical');
  assert.equal(i.recoveryRecorded, true);
  assert.equal(i.unresolved, false);
  assert.deepEqual(i.openFailures, []);
  assert.equal(i.duration, 600);
  assert.deepEqual(i.actionsTaken, ['notification_sent', 'shutdown_initiated']);
});

test('a lone self-test or recovery is not an incident', async () => {
  const { incidents } = await timeline([
    ev('t', 'test', 'info', '2024-01-01T01:00:00Z'),
    ev('ol', 'power_restored', 'info', '2024-01-01T03:00:00Z')
  ], HIST);
  assert.equal(incidents.length, 0);
});

test('a gap without a recorded recovery closes the incident without claiming it is ongoing', async () => {
  const { incidents } = await timeline([
    ev('ov', 'overload', 'critical', '2024-01-01T00:00:00Z'),
    ev('ov2', 'overload', 'critical', '2024-01-01T00:05:00Z'),
    ev('ob', 'on_battery', 'warning', '2024-01-01T02:00:00Z')
  ], { ...HIST, proximityMinutes: 15 });

  assert.equal(incidents.length, 2);
  assert.equal(incidents[0].recoveryRecorded, false);
  assert.equal(incidents[0].unresolved, false, 'later events followed it');
  assert.equal(incidents[0].endTime, null);
  assert.equal(incidents[0].duration, 300, 'observed span only');
  assert.deepEqual(incidents[0].openFailures, ['overload']);
  // Historical window: nothing can be known about after the window end.
  assert.equal(incidents[1].unresolved, false);
});

test('the newest unrecovered incident is unresolved when the window reaches now', async () => {
  const startedAt = new Date(Date.now() - 10 * 60 * 1000);
  const { incidents } = await timeline([
    { eventId: 'ob', upsName: 'ups-a', eventType: 'on_battery', severity: 'warning', createdAt: startedAt }
  ], {});
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].unresolved, true);
  assert.ok(incidents[0].duration >= 599);
});

test('invalid ranges are rejected', async () => {
  await assert.rejects(() => timeline([], { start: '2024-02-01', end: '2024-01-01' }), RangeError);
  await assert.rejects(() => timeline([], { start: '2024-01-01', end: '2024-03-01' }), RangeError);
  await assert.rejects(() => timeline([], { ...HIST, limit: 0 }), TypeError);
});

test('getUnresolvedIncidents returns only unresolved incidents', async () => {
  const originalBuildIncidentTimeline = UpsEvent.buildIncidentTimeline;
  const mockIncidents = [
    { upsName: 'ups-a', unresolved: true, startTime: new Date() },
    { upsName: 'ups-a', unresolved: false, startTime: new Date() },
    { upsName: 'ups-b', unresolved: true, startTime: new Date() }
  ];
  UpsEvent.buildIncidentTimeline = async () => mockIncidents;
  try {
    const unresolved = await UpsEvent.getUnresolvedIncidents();
    assert.equal(unresolved.length, 2);
    assert.deepEqual(unresolved.map(i => i.unresolved), [true, true]);
  } finally {
    UpsEvent.buildIncidentTimeline = originalBuildIncidentTimeline;
  }
});

test('getUnresolvedIncidents passes upsName filter to buildIncidentTimeline', async () => {
  const originalBuildIncidentTimeline = UpsEvent.buildIncidentTimeline;
  let capturedOptions;
  UpsEvent.buildIncidentTimeline = async (options) => {
    capturedOptions = options;
    return [];
  };
  try {
    await UpsEvent.getUnresolvedIncidents('ups-x');
    assert.equal(capturedOptions.upsName, 'ups-x');
    assert.ok(capturedOptions.end instanceof Date);
    // Must pass the timeline's range and limit checks, and not lose the newest incident to the limit.
    assert.equal(capturedOptions.end - capturedOptions.start, 7 * 24 * 60 * 60 * 1000);
    assert.equal(capturedOptions.limit, 1000);
  } finally {
    UpsEvent.buildIncidentTimeline = originalBuildIncidentTimeline;
  }
});

test('getUnresolvedIncidents over real timeline logic: open outage yes, recovered outage no', async () => {
  const originalFind = UpsEvent.find;
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const set = (events) => { UpsEvent.find = () => ({ sort() { return this; }, limit() { return this; }, async lean() { return events; } }); };
  try {
    set([ev('a', 'on_battery', 'warning', ago(5))]);
    const open = await UpsEvent.getUnresolvedIncidents();
    assert.equal(open.length, 1);
    assert.equal(open[0].unresolved, true);

    set([ev('a', 'on_battery', 'warning', ago(10)), ev('b', 'power_restored', 'info', ago(5))]);
    assert.equal((await UpsEvent.getUnresolvedIncidents()).length, 0);
  } finally {
    UpsEvent.find = originalFind;
  }
});
