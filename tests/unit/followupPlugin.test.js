import { test } from 'node:test';
import assert from 'node:assert/strict';
import FollowUpPlugin from '../../src/api/plugins/followup.js';

function plugin({ running = true } = {}) {
  const jobs = [];
  const agent = running ? { scheduler: { agenda: { schedule: async (when, name, data) => { jobs.push({ when, name, data }); } } } } : {};
  return { p: new FollowUpPlugin(agent), jobs };
}

test('batch schedules each valid task and reports invalid ones per item', async () => {
  const { p, jobs } = plugin();
  const r = await p.execute({ action: 'batch', tasks: [{ task: 'check job 1', inMinutes: 5 }, { task: '  ' }, { task: 'check job 2', inMinutes: 30 }], _context: { userId: 'u1' } });
  assert.equal(r.success, true);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].data.userId, 'u1');
  assert.deepEqual(r.scheduled.map(x => x.success), [true, false, true]);
  assert.match(r.result, /2 of 3/);
});

test('batch with nothing scheduled is a failure so the promised check-back safety net still fires', async () => {
  const { p } = plugin({ running: false });
  const r = await p.execute({ action: 'batch', tasks: [{ task: 'check job 1' }] });
  assert.equal(r.success, false);
  assert.equal(r.scheduled[0].success, false);
});

test('batch rejects an empty or oversized list; schedule still works', async () => {
  const { p, jobs } = plugin();
  assert.equal((await p.execute({ action: 'batch', tasks: [] })).success, false);
  assert.equal((await p.execute({ action: 'batch', tasks: Array.from({ length: 11 }, (_, i) => ({ task: `t${i}` })) })).success, false);
  assert.equal(jobs.length, 0);
  const r = await p.execute({ action: 'schedule', task: 'check again', inMinutes: 5 });
  assert.equal(r.success, true);
  assert.equal((await p.execute({ action: 'nope' })).success, false);
});
