import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../../src/models/Journal.js';

test('searchContent applies composable filters while preserving relevance ordering', async () => {
  const rows = [{ _id: 'relevant' }, { _id: 'less-relevant' }];
  let query;
  let sortSpec;
  const originalFind = Journal.find;

  const chain = {
    sort(spec) { sortSpec = spec; return this; },
    skip(value) { assert.equal(value, 1); return this; },
    limit(value) { assert.equal(value, 2); return this; },
    lean() { return this; },
    then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); }
  };

  Journal.find = filter => {
    query = filter;
    return chain;
  };

  Journal.cache.flushAll();
  try {
    const result = await Journal.searchContent('user-1', 'coffee notes', {
      limit: 2,
      skip: 1,
      status: 'active',
      source: 'voice',
      tags: ['health', 'coffee'],
      startDate: '2024-01-01T00:00:00.000Z',
      endDate: '2024-01-31T23:59:59.999Z'
    });

    assert.deepEqual(result, rows);
    assert.deepEqual(query.$text, { $search: 'coffee notes' });
    assert.equal(query.userId, 'user-1');
    assert.equal(query.status, 'active');
    assert.equal(query['entries.source'], 'voice');
    assert.deepEqual(query.tags, { $all: ['health', 'coffee'] });
    assert.deepEqual(query.createdAt, {
      $gte: new Date('2024-01-01T00:00:00.000Z'),
      $lte: new Date('2024-01-31T23:59:59.999Z')
    });
    assert.deepEqual(sortSpec.score, { $meta: 'textScore' });
  } finally {
    Journal.find = originalFind;
  }
});

test('legacy numeric (limit, skip) signature still works; includeCount adds total', async () => {
  const originalFind = Journal.find;
  const originalCount = Journal.countDocuments;
  let seen = {};
  const chain = {
    sort() { return this; },
    skip(v) { seen.skip = v; return this; },
    limit(v) { seen.limit = v; return this; },
    then(resolve, reject) { return Promise.resolve([{ _id: 'a' }]).then(resolve, reject); }
  };
  Journal.find = () => chain;
  Journal.countDocuments = async () => 7;
  Journal.cache.flushAll();
  try {
    const legacy = await Journal.searchContent('u', 'x', 5, 10);
    assert.deepEqual(seen, { skip: 10, limit: 5 });
    assert.deepEqual(legacy, [{ _id: 'a' }]);
    const counted = await Journal.searchContent('u', 'y', { includeCount: true });
    assert.equal(counted.total, 7);
    await assert.rejects(Journal.searchContent('u', 'y', { status: 'bogus' }), /status/);
  } finally {
    Journal.find = originalFind;
    Journal.countDocuments = originalCount;
  }
});

test('save hook flushes the model cache (document middleware reaches the Model via constructor)', async () => {
  Journal.cache.set('k', 1);
  const hooks = Journal.schema.s.hooks._posts.get('save') || [];
  const doc = new Journal({ userId: 'u' });
  for (const h of hooks) { try { h.fn.call(doc, doc, () => {}); } catch {} }
  assert.equal(Journal.cache.get('k'), undefined);
});

test('transitionMap defines allowed transitions', () => {
  assert.deepEqual(Journal.transitionMap, { active: ['closed'] });
});

test('transitionStatus atomically transitions active journal to closed', async () => {
  const journalId = '507f1f77bcf86cd799439011';
  const mockUpdated = { _id: journalId, status: 'closed', metadata: { closedAt: new Date() } };
  let findOneAndUpdateArgs;
  const originalFindOneAndUpdate = Journal.findOneAndUpdate;
  Journal.findOneAndUpdate = (query, update, options) => {
    findOneAndUpdateArgs = { query, update, options };
    return Promise.resolve(mockUpdated);
  };
  try {
    const result = await Journal.transitionStatus(journalId, 'closed');
    assert.deepEqual(result, mockUpdated);
    assert.deepEqual(findOneAndUpdateArgs.query, { _id: journalId, status: { $in: ['active'] } });
    assert.deepEqual(findOneAndUpdateArgs.update, { $set: { status: 'closed', 'metadata.closedAt': findOneAndUpdateArgs.update.$set['metadata.closedAt'] } });
    assert.ok(findOneAndUpdateArgs.update.$set['metadata.closedAt'] instanceof Date);
    assert.deepEqual(findOneAndUpdateArgs.options, { new: true });
  } finally {
    Journal.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('transitionStatus returns null when journal is not in a valid source state', async () => {
  const journalId = '507f1f77bcf86cd799439011';
  const originalFindOneAndUpdate = Journal.findOneAndUpdate;
  Journal.findOneAndUpdate = () => Promise.resolve(null);
  try {
    const result = await Journal.transitionStatus(journalId, 'closed');
    assert.equal(result, null);
  } finally {
    Journal.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('close claims the transition, then persists summary, duration and caller-set fields', async () => {
  const journalId = '507f1f77bcf86cd799439011';
  const closedAt = new Date('2026-01-01T01:00:00Z');
  const originalTransitionStatus = Journal.transitionStatus;
  Journal.transitionStatus = async (id, newStatus) => {
    assert.equal(id.toString(), journalId);
    assert.equal(newStatus, 'closed');
    return { _id: journalId, status: 'closed', metadata: { closedAt } };
  };
  const journal = new Journal({ userId: 'u', status: 'active' });
  journal._id = journalId;
  journal.createdAt = new Date('2026-01-01T00:30:00Z');
  journal.title = 'AI title'; // stopJournal sets these before close()
  let saveCalled = 0;
  journal.save = function() { saveCalled++; return Promise.resolve(this); };
  Journal.cache.set('k', 1);
  try {
    const result = await journal.close('final summary');
    assert.equal(result, journal);
    assert.equal(journal.status, 'closed');
    assert.equal(journal.summary, 'final summary');
    assert.equal(journal.metadata.closedAt, closedAt);
    assert.equal(journal.metadata.sessionDuration, 30 * 60 * 1000);
    assert.equal(saveCalled, 1);
    assert.equal(Journal.cache.get('k'), undefined, 'cache flushed');
  } finally {
    Journal.transitionStatus = originalTransitionStatus;
  }
});

test('close without a summary still saves (title/tags/mood must persist)', async () => {
  const originalTransitionStatus = Journal.transitionStatus;
  Journal.transitionStatus = async () => ({ status: 'closed', metadata: { closedAt: new Date() } });
  const journal = new Journal({ userId: 'u', status: 'active' });
  let saveCalled = 0;
  journal.save = function() { saveCalled++; return Promise.resolve(this); };
  try {
    await journal.close();
    assert.equal(journal.status, 'closed');
    assert.equal(journal.summary, '');
    assert.equal(saveCalled, 1);
  } finally {
    Journal.transitionStatus = originalTransitionStatus;
  }
});

test('close throws if transitionStatus returns null (already closed / lost the race)', async () => {
  const originalTransitionStatus = Journal.transitionStatus;
  Journal.transitionStatus = async () => null;
  const journal = new Journal({ userId: 'u', status: 'active' });
  let saveCalled = 0;
  journal.save = function() { saveCalled++; return Promise.resolve(this); };
  try {
    await assert.rejects(() => journal.close(), /Cannot close journal/);
    assert.equal(saveCalled, 0);
  } finally {
    Journal.transitionStatus = originalTransitionStatus;
  }
});
