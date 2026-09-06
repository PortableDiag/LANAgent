/**
 * The two statics this PR adds, tested without a live mongo.
 *
 * The shipped test did `import ContractEvent from '...'` — a default import from
 * a module that only has the named export `ContractEvent`. Node refused to load
 * the file at all (`SyntaxError: does not provide an export named 'default'`), so
 * it never ran, and it only ever targeted `getEventCountsByType`, a pre-existing
 * static this PR does not touch.
 *
 * These stub `aggregate` and assert the pipeline that gets built — the guards and
 * clamps are real logic worth pinning, and the stage shapes catch a pipeline that
 * silently stops matching what the schema stores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractEvent } from '../../src/models/ContractEvent.js';

// Capture the pipeline instead of running it.
const capturePipeline = (result = []) => {
  const calls = [];
  const original = ContractEvent.aggregate;
  ContractEvent.aggregate = (pipeline) => {
    calls.push(pipeline);
    return { exec: async () => result };
  };
  return { calls, restore: () => { ContractEvent.aggregate = original; } };
};

const stageNamed = (pipeline, name) => pipeline.find(s => Object.keys(s)[0] === name);

test('findCorrelatedEvents requires a transaction hash', async (t) => {
  const cap = capturePipeline();
  t.after(cap.restore);

  await assert.rejects(() => ContractEvent.findCorrelatedEvents(), /Transaction hash is required/);
  await assert.rejects(() => ContractEvent.findCorrelatedEvents(''), /Transaction hash is required/);
  assert.equal(cap.calls.length, 0, 'nothing should reach the database');
});

test('findCorrelatedEvents lower-cases the hash it matches on', async (t) => {
  const cap = capturePipeline();
  t.after(cap.restore);

  await ContractEvent.findCorrelatedEvents('0xABCDEF');

  // The writer stores transactionHash as it comes off the provider; the
  // contractAddress beside it is explicitly lower-cased on write, so matching a
  // mixed-case hash without normalising would quietly return nothing.
  assert.deepEqual(stageNamed(cap.calls[0], '$match').$match, { transactionHash: '0xabcdef' });
});

test('findCorrelatedEvents orders by contract then log index', async (t) => {
  const cap = capturePipeline();
  t.after(cap.restore);

  await ContractEvent.findCorrelatedEvents('0xabc');

  assert.deepEqual(stageNamed(cap.calls[0], '$sort').$sort, { contractAddress: 1, logIndex: 1 },
    'correlated events are only meaningful in emission order');
});

test('detectEventPatterns forces a sequence length of at least 2', async (t) => {
  const cap = capturePipeline();
  t.after(cap.restore);

  // A "sequence" of one event is just an event count, and the $range maths below
  // would produce one window per event rather than per pair.
  for (const asked of [undefined, 0, 1, -5]) {
    cap.calls.length = 0;
    await ContractEvent.detectEventPatterns({}, asked);
    const slice = stageNamed(cap.calls[0], '$project').$project.eventSequences.$map.in.$slice;
    assert.equal(slice[2], 2, `minSequenceLength ${asked} must clamp up to 2`);
  }
});

test('detectEventPatterns honours a larger sequence length', async (t) => {
  const cap = capturePipeline();
  t.after(cap.restore);

  await ContractEvent.detectEventPatterns({}, 4);

  const project = stageNamed(cap.calls[0], '$project').$project;
  assert.equal(project.eventSequences.$map.in.$slice[2], 4);
  assert.equal(project.eventSequences.$map.input.$range[1].$subtract[1], 3,
    'the window count must be size - (length - 1) so the last window is full');
});

test('detectEventPatterns bounds the limit to 1..100', async (t) => {
  const cap = capturePipeline();
  t.after(cap.restore);

  const limitOf = async (asked) => {
    cap.calls.length = 0;
    await ContractEvent.detectEventPatterns({}, 2, asked);
    return stageNamed(cap.calls[0], '$limit').$limit;
  };

  assert.equal(await limitOf(500), 100, 'an oversized limit clamps down');
  assert.equal(await limitOf(0), 1, 'a zero limit clamps up rather than returning nothing');
  assert.equal(await limitOf(25), 25);
});

test('detectEventPatterns passes the caller filter through untouched', async (t) => {
  const cap = capturePipeline();
  t.after(cap.restore);

  const filter = { network: 'bsc', contractAddress: '0xabc' };
  await ContractEvent.detectEventPatterns(filter);

  assert.deepEqual(stageNamed(cap.calls[0], '$match').$match, filter);
});

test('detectEventPatterns sorts each transaction by log index before slicing', async (t) => {
  const cap = capturePipeline();
  t.after(cap.restore);

  await ContractEvent.detectEventPatterns({});

  // $group does not preserve order, so without this the "sequences" would be
  // whatever order the documents happened to come back in. $sortArray needs
  // MongoDB 5.2+; production runs 7.0.
  const sortArray = stageNamed(cap.calls[0], '$addFields').$addFields.events.$sortArray;
  assert.deepEqual(sortArray.sortBy, { logIndex: 1 });
});

test('detectEventPatterns discards one-off sequences', async (t) => {
  const cap = capturePipeline();
  t.after(cap.restore);

  await ContractEvent.detectEventPatterns({});

  const countFilter = cap.calls[0].filter(s => s.$match).pop().$match;
  assert.deepEqual(countFilter, { count: { $gt: 1 } },
    'a sequence seen once is not a pattern');
});

test('detectEventPatterns returns the rows the aggregation produced', async (t) => {
  const rows = [{ pattern: 'Approval -> Transfer', count: 4, transactionCount: 4 }];
  const cap = capturePipeline(rows);
  t.after(cap.restore);

  assert.deepEqual(await ContractEvent.detectEventPatterns({}), rows);
});
