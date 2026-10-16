import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rotateVpnShared, _resetVpnRotationForTests } from '../../src/api/external/routes/scraping.js';

// One exit switch at a time, at most one per minute: two tiers of one blocked scrape each switched
// the exit, four switches in 90 s, each dropping the whole host's egress (2026-10-07).

beforeEach(() => _resetVpnRotationForTests());

function vpn(delayMs = 20) {
  const calls = [];
  return { calls, connect: async ({ location }) => { calls.push(location); await new Promise(r => setTimeout(r, delayMs)); return { success: true, location }; } };
}

test('two scrapes blocked at once share one switch', async () => {
  const v = vpn();
  const [a, b] = await Promise.all([rotateVpnShared(v, 'usa-miami', 'usa-seattle'), rotateVpnShared(v, 'usa-miami', 'usa-dallas')]);
  assert.deepEqual(v.calls, ['usa-seattle']);
  assert.equal(a.location, 'usa-seattle');
  assert.equal(b.location, 'usa-seattle');
  assert.equal(b.shared, true);
});

test('a scrape blocked on the OLD exit just after a switch reuses the new exit', async () => {
  const v = vpn(1);
  await rotateVpnShared(v, 'usa-miami', 'usa-seattle');
  const r = await rotateVpnShared(v, 'usa-miami', 'usa-dallas');
  assert.deepEqual(v.calls, ['usa-seattle']);
  assert.equal(r.reused, true);
  assert.equal(r.location, 'usa-seattle');
});

test('blocked on the NEWEST exit inside the gap: no second switch', async () => {
  const v = vpn(1);
  await rotateVpnShared(v, 'usa-miami', 'usa-seattle');
  const r = await rotateVpnShared(v, 'usa-seattle', 'usa-dallas');
  assert.equal(r.throttled, true);
  assert.deepEqual(v.calls, ['usa-seattle']);
});

test('after the gap a new switch is allowed', async () => {
  const v = vpn(1);
  let t = 1_000_000;
  await rotateVpnShared(v, 'usa-miami', 'usa-seattle', { now: () => t });
  t += 61_000;
  const r = await rotateVpnShared(v, 'usa-seattle', 'usa-dallas', { now: () => t });
  assert.equal(r.location, 'usa-dallas');
  assert.deepEqual(v.calls, ['usa-seattle', 'usa-dallas']);
});

test('a failed switch does not start the gap', async () => {
  const v = { calls: [], connect: async ({ location }) => { v.calls.push(location); return { success: false, error: 'timeout' }; } };
  await rotateVpnShared(v, 'usa-miami', 'usa-seattle');
  await rotateVpnShared(v, 'usa-miami', 'usa-dallas');
  assert.deepEqual(v.calls, ['usa-seattle', 'usa-dallas']);
});

// 2026-10-15: nearly every switch failed for an evening; each failure left the tunnel down until the
// watchdog restored it, and the next blocked scrape switched again.
test('three failed switches in a row suspend rotation; a success resets the count', async () => {
  let t = 1_000_000;
  const now = () => t;
  const calls = [];
  const failing = { connect: async ({ location }) => { calls.push(location); return { success: false, error: 'Exit switch did not complete' }; } };
  for (const loc of ['a', 'b', 'c']) assert.equal((await rotateVpnShared(failing, 'x', loc, { now })).success, false);
  const r = await rotateVpnShared(failing, 'x', 'd', { now });
  assert.equal(r.suspended, true);
  assert.deepEqual(calls, ['a', 'b', 'c'], 'no fourth switch while suspended');

  t += 31 * 60 * 1000;                      // cooldown over
  const ok = { connect: async ({ location }) => ({ success: true, location }) };
  assert.equal((await rotateVpnShared(ok, 'x', 'e', { now })).success, true);
  t += 61_000;
  await rotateVpnShared(failing, 'e', 'f', { now });
  await rotateVpnShared(failing, 'e', 'g', { now });
  assert.notEqual((await rotateVpnShared(failing, 'e', 'h', { now })).suspended, true, 'success reset the count: 3rd failure opens it, does not hit it');
  assert.equal((await rotateVpnShared(failing, 'e', 'i', { now })).suspended, true);
});

test('a switch that throws counts as a failure', async () => {
  const now = () => 5_000_000;
  const boom = { connect: async () => { throw new Error('Connection timeout'); } };
  for (let i = 0; i < 3; i++) await assert.rejects(rotateVpnShared(boom, 'x', `l${i}`, { now }));
  assert.equal((await rotateVpnShared(boom, 'x', 'l4', { now })).suspended, true);
});
