/**
 * "Cancel the email" from chat carries no job id. cancelScheduled demanded one, the cancel failed,
 * and a scheduled email the owner had just called off stayed queued (2026-10-20).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import EmailPlugin from '../../src/api/plugins/email.js';

const OID = ['6ad7b670601bdffda1f8b521', '6ad7b670601bdffda1f8b522'];
function pluginWith(jobs) {
  const p = Object.create(EmailPlugin.prototype);
  const cancelled = [];
  p.logger = { error() {}, info() {} };
  p.agent = { scheduler: { agenda: {
    jobs: async () => jobs.map((d, i) => ({ attrs: { _id: { toString: () => OID[i] }, nextRunAt: new Date(Date.now() + 6e5), data: d } })),
    cancel: async (q) => { cancelled.push(q._id.toString()); return 1; }
  } } };
  return { p, cancelled };
}
const sam = { to: 'sam@example.com', subject: 'Thank you', text: 'Dear Sam Carter, thanks' };
const bob = { to: 'bob@example.com', subject: 'Lunch', text: 'Hi Bob' };

test('with no job id, the one pending email is cancelled', async () => {
  const { p, cancelled } = pluginWith([sam]);
  const r = await p.cancelScheduledEmail({});
  assert.equal(r.success, true);
  assert.deepEqual(cancelled, [OID[0]]);
  assert.match(r.message, /sam@example\.com/);
});

test('a name matches the body when the address does not contain it', async () => {
  const { p, cancelled } = pluginWith([bob, sam]);
  const r = await p.cancelScheduledEmail({ to: 'Sam' });
  assert.equal(r.success, true);
  assert.deepEqual(cancelled, [OID[1]]);
});

test('several pending and no name: lists them, cancels nothing', async () => {
  const { p, cancelled } = pluginWith([bob, sam]);
  const r = await p.cancelScheduledEmail({});
  assert.equal(r.success, false);
  assert.match(r.error, /2 scheduled emails are waiting/);
  assert.deepEqual(cancelled, []);
});

test('nothing pending: says so', async () => {
  const { p } = pluginWith([]);
  const r = await p.cancelScheduledEmail({});
  assert.equal(r.success, false);
  assert.match(r.error, /no scheduled email/);
});
