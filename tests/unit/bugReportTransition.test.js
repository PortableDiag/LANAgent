import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BugReport } from '../../src/models/BugReport.js';

function stubFindOneAndUpdate(result) {
  const calls = [];
  mock.method(BugReport, 'findOneAndUpdate', async (filter, update, options) => {
    calls.push({ filter, update, options });
    return result;
  });
  return calls;
}

test('every status in the schema enum has a transitionMap entry and targets are valid', () => {
  const enumValues = BugReport.schema.path('status').enumValues;
  assert.deepEqual(Object.keys(BugReport.transitionMap).sort(), [...enumValues].sort());
  for (const targets of Object.values(BugReport.transitionMap)) {
    for (const t of targets) assert.ok(enumValues.includes(t), `${t} is a real status`);
  }
});

test('new -> fixed is allowed (the path self-modification uses)', async () => {
  const calls = stubFindOneAndUpdate({ bugId: 'B1', status: 'fixed', title: 't' });
  try {
    const out = await BugReport.transitionStatus('B1', 'fixed');
    assert.equal(out.status, 'fixed');
    assert.equal(calls[0].filter.bugId, 'B1');
    assert.ok(calls[0].filter.status.$in.includes('new'));
    assert.ok(!calls[0].filter.status.$in.includes('fixed'), 'fixed -> fixed is not a transition');
    assert.equal(calls[0].update.$set.status, 'fixed');
    assert.equal(calls[0].update.$push.history.status, 'fixed');
    assert.ok(calls[0].update.$push.history.changedAt instanceof Date);
  } finally {
    mock.restoreAll();
  }
});

test('reopen: only closed/active statuses other than new can go back to new', async () => {
  const calls = stubFindOneAndUpdate({ bugId: 'B2', status: 'new' });
  try {
    await BugReport.transitionStatus('B2', 'new');
    assert.deepEqual([...calls[0].filter.status.$in].sort(),
      ['analyzing', 'duplicate', 'fixed', 'ignored', 'in-progress']);
  } finally {
    mock.restoreAll();
  }
});

test('returns null for an unknown target or when the precondition does not match', async () => {
  const calls = stubFindOneAndUpdate(null);
  try {
    assert.equal(await BugReport.transitionStatus('B3', 'bogus'), null);
    assert.equal(calls.length, 0, 'unknown target never hits the DB');
    assert.equal(await BugReport.transitionStatus('B3', 'fixed'), null);
    assert.equal(calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});

test('a failing notifier does not fail the transition', async () => {
  stubFindOneAndUpdate({ bugId: 'B4', status: 'ignored', title: 't', file: 'f.js' });
  const prev = global.agent;
  global.agent = { notify: async () => { throw new Error('telegram down'); } };
  try {
    const out = await BugReport.transitionStatus('B4', 'ignored');
    assert.equal(out.status, 'ignored');
  } finally {
    global.agent = prev;
    mock.restoreAll();
  }
});
