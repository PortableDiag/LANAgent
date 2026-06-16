import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryVectorStore } from '../../src/services/memoryVectorStore.js';

// Build a fake LanceDB table that records search() invocations and returns
// a deterministic result. We sidestep the LanceDB import entirely by
// instantiating the store and setting its .table / .initialized directly.
function makeStubTable() {
  const calls = { search: 0, delete: 0, add: 0 };
  const result = (distance) => ({
    id: 'mem-1',
    contentPreview: 'preview',
    type: 'note',
    userId: 'u1',
    category: '',
    importance: 5,
    tags: '[]',
    source: '',
    context: '',
    createdAt: new Date().toISOString(),
    vector: [0.1, 0.2],
    _distance: distance
  });
  const table = {
    search(_emb) {
      calls.search += 1;
      return {
        limit() { return this; },
        where() { return this; },
        toArray: async () => [result(0.05)]
      };
    },
    async delete() { calls.delete += 1; },
    async add() { calls.add += 1; },
    async countRows() { return 1; }
  };
  return { table, calls };
}

function makeStore() {
  process.env.ENABLE_SEARCH_CACHE = 'true';
  process.env.ENABLE_DUP_CACHE = 'true';
  process.env.SEARCH_CACHE_TTL = '300';
  const store = new MemoryVectorStore();
  const { table, calls } = makeStubTable();
  store.table = table;
  store.initialized = true;
  return { store, calls };
}

const emb = Array.from({ length: 8 }, (_, i) => i + 0.1);

test('findDuplicate hits cache on identical embedding+threshold', async () => {
  const { store, calls } = makeStore();
  const a = await store.findDuplicate(emb, 0.85);
  const b = await store.findDuplicate(emb, 0.85);
  assert.equal(calls.search, 1, 'underlying table.search called once across two findDuplicate calls');
  assert.deepEqual(a, b);
});

test('findDuplicate cache key includes threshold (different threshold → fresh lookup)', async () => {
  const { store, calls } = makeStore();
  await store.findDuplicate(emb, 0.85);
  await store.findDuplicate(emb, 0.90);
  assert.equal(calls.search, 2);
});

test('search hits cache on identical embedding+options', async () => {
  const { store, calls } = makeStore();
  await store.search(emb, { limit: 5, minSimilarity: 0.5 });
  await store.search(emb, { limit: 5, minSimilarity: 0.5 });
  assert.equal(calls.search, 1);
});

test('search cache key includes options (different limit → fresh lookup)', async () => {
  const { store, calls } = makeStore();
  await store.search(emb, { limit: 5 });
  await store.search(emb, { limit: 10 });
  assert.equal(calls.search, 2);
});

test('delete invalidates cache so next search re-hits the table', async () => {
  const { store, calls } = makeStore();
  await store.search(emb, { limit: 5 });
  assert.equal(calls.search, 1);
  await store.search(emb, { limit: 5 }); // cached
  assert.equal(calls.search, 1);

  await store.deleteMemory('mem-1');
  assert.equal(calls.delete, 1);

  await store.search(emb, { limit: 5 }); // cache busted, hits table
  assert.equal(calls.search, 2);
});

test('deleteMemories invalidates cache', async () => {
  const { store, calls } = makeStore();
  await store.findDuplicate(emb, 0.85);
  assert.equal(calls.search, 1);
  await store.findDuplicate(emb, 0.85); // cached
  assert.equal(calls.search, 1);

  await store.deleteMemories(['mem-1', 'mem-2']);
  await store.findDuplicate(emb, 0.85);
  assert.equal(calls.search, 2);
});

test('disabling cache via env flag bypasses caching', async () => {
  process.env.ENABLE_SEARCH_CACHE = 'false';
  process.env.ENABLE_DUP_CACHE = 'false';
  const store = new MemoryVectorStore();
  const { table, calls } = makeStubTable();
  store.table = table;
  store.initialized = true;

  await store.search(emb, { limit: 5 });
  await store.search(emb, { limit: 5 });
  assert.equal(calls.search, 2);

  await store.findDuplicate(emb, 0.85);
  await store.findDuplicate(emb, 0.85);
  assert.equal(calls.search, 4);

  // reset for other tests
  process.env.ENABLE_SEARCH_CACHE = 'true';
  process.env.ENABLE_DUP_CACHE = 'true';
});
