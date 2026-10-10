import test from 'node:test';
import assert from 'node:assert/strict';
import { RAGVectorStore } from '../../src/services/ragVectorStore.js';

test('addDocuments writes records in configurable LanceDB batches', async () => {
  const store = new RAGVectorStore();
  const originalTable = store.table;
  const originalInitialized = store.initialized;
  const originalDb = store.db;
  const addedBatches = [];

  store.initialized = true;
  store.table = {
    add: async batch => addedBatches.push(batch)
  };

  const records = [
    { id: 'doc-1', vector: [1, 0], content: 'one', source: 'source-a', chunk: 1 },
    { id: 'doc-2', vector: [0, 1], content: 'two', source: 'source-a', chunk: 2 },
    { id: 'doc-3', vector: [1, 1], content: 'three', source: 'source-a', chunk: 3 },
    { id: 'doc-4', vector: [2, 0], content: 'four', source: 'source-a', chunk: 4 },
    { id: 'doc-5', vector: [0, 2], content: 'five', source: 'source-a', chunk: 5 }
  ];

  try {
    const result = await store.addDocuments(records, { batchSize: 2 });

    assert.deepEqual(result, {
      ids: ['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5'],
      count: 5
    });
    assert.equal(addedBatches.length, 3);
    assert.deepEqual(addedBatches.map(batch => batch.length), [2, 2, 1]);
    assert.deepEqual(
      addedBatches.flat().map(row => row.id),
      records.map(record => record.id)
    );
    assert.equal(addedBatches[0][0].content, 'one');
    assert.equal(addedBatches[0][0].source, 'source-a');
    assert.deepEqual(JSON.parse(addedBatches[0][0].metadata), { chunk: 1 });
  } finally {
    store.table = originalTable;
    store.initialized = originalInitialized;
    store.db = originalDb;
  }
});

test('addDocuments lazily creates the table without adding an empty batch', async () => {
  const store = new RAGVectorStore();
  const originalTable = store.table;
  const originalInitialized = store.initialized;
  const originalDb = store.db;
  let createdRows;
  const addedBatches = [];

  store.initialized = true;
  store.db = {
    createTable: async (name, rows) => {
      assert.equal(name, 'rag_documents');
      createdRows = rows;
      return {
        add: async batch => addedBatches.push(batch)
      };
    }
  };

  try {
    const result = await store.addDocuments([
      { id: 'first', vector: [1, 2], content: 'first' }
    ]);

    assert.deepEqual(result, { ids: ['first'], count: 1 });
    assert.equal(createdRows.length, 1);
    assert.equal(createdRows[0].id, 'first');
    assert.deepEqual(addedBatches, []);
  } finally {
    store.table = originalTable;
    store.initialized = originalInitialized;
    store.db = originalDb;
  }
});

test('RAGChain.storeChunks writes all vectors in one batched call', async () => {
  const { RAGChain } = await import('../../src/services/rag/ragChain.js');
  const batches = [];
  const memory = [];
  const chain = new RAGChain({
    vectorStore: {
      addDocuments: async recs => { batches.push(recs); return { ids: recs.map(r => r.id), count: recs.length }; },
      addDocument: async () => { throw new Error('per-record path must not run'); }
    },
    embeddingProvider: { generateEmbedding: async text => (text === 'skip' ? null : [1, 2]) },
    memoryManager: { store: async (...a) => memory.push(a) }
  });
  const chunks = ['a', 'skip', 'b'].map((t, i) => ({ pageContent: t, metadata: { source: 's', chunkIndex: i } }));
  const stored = await chain.storeChunks(chunks, { tag: 'x' });
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(r => r.content), ['a', 'b']);
  assert.equal(batches[0][0].tag, 'x');
  assert.equal(stored.length, 2);
  assert.equal(memory.length, 2);
  assert.deepEqual(stored.map(s => s.id), batches[0].map(r => r.id));
});

test('RAGChain.storeChunks falls back to per-record writes and reports only written rows', async () => {
  const { RAGChain } = await import('../../src/services/rag/ragChain.js');
  const single = [];
  const memory = [];
  const chain = new RAGChain({
    vectorStore: {
      addDocuments: async () => { throw new Error('batch failed'); },
      addDocument: async rec => { if (rec.content === 'bad') throw new Error('bad row'); single.push(rec.content); return rec.id; }
    },
    embeddingProvider: { generateEmbedding: async () => [1] },
    memoryManager: { store: async (...a) => memory.push(a) }
  });
  const chunks = ['ok1', 'bad', 'ok2'].map(t => ({ pageContent: t, metadata: { source: 's' } }));
  const stored = await chain.storeChunks(chunks);
  assert.deepEqual(single, ['ok1', 'ok2']);
  assert.equal(stored.length, 2);
  assert.equal(memory.length, 2);
});

// --- New tests for advanced metadata filtering ---

test('_buildFilterClause generates correct SQL for equality and operators', () => {
  const store = new RAGVectorStore();

  // plain equality
  assert.equal(store._buildFilterClause('source', 'doc.txt'), "source = 'doc.txt'");
  // equality is always a quoted string literal (every column is a string),
  // unchanged from before operators existed
  assert.equal(store._buildFilterClause('count', 5), "count = '5'");
  assert.equal(
    store._buildFilterClause('ingestedAt', new Date('2026-01-02T03:04:05.000Z')),
    `"ingestedAt" = '2026-01-02T03:04:05.000Z'`
  );
  assert.equal(
    store._buildFilterClause('ingestedAt', { $gte: new Date('2026-01-01T00:00:00.000Z') }),
    `"ingestedAt" >= '2026-01-01T00:00:00.000Z'`
  );

  // $gt
  assert.equal(store._buildFilterClause('count', { $gt: 5 }), "count > 5");
  // $lt
  assert.equal(store._buildFilterClause('count', { $lt: 10 }), "count < 10");
  // $gte
  assert.equal(store._buildFilterClause('count', { $gte: 0 }), "count >= 0");
  // $lte
  assert.equal(store._buildFilterClause('count', { $lte: 100 }), "count <= 100");
  // $ne
  assert.equal(store._buildFilterClause('status', { $ne: 'deleted' }), "status != 'deleted'");

  // $in
  assert.equal(store._buildFilterClause('type', { $in: ['a', 'b'] }), "type IN ('a', 'b')");

  // multiple operators on same field (order is deterministic but not important)
  const multi = store._buildFilterClause('count', { $gt: 5, $lt: 10 });
  assert.ok(multi.startsWith('(') && multi.endsWith(')'));
  assert.ok(multi.includes('count > 5'));
  assert.ok(multi.includes('count < 10'));
  assert.ok(multi.includes(' AND '));

  // null / undefined value returns null
  assert.equal(store._buildFilterClause('field', null), null);
  assert.equal(store._buildFilterClause('field', undefined), null);

  // unsupported operator objects fail CLOSED (never-match), never dropped:
  // dropping a clause would broaden a search or a delete
  const NEVER = RAGVectorStore.NEVER_MATCH;
  assert.equal(store._buildFilterClause('field', { foo: 'bar' }), NEVER);
  assert.equal(store._buildFilterClause('field', {}), NEVER);
  assert.equal(store._buildFilterClause('field', { $gt: 1, $gtt: 2 }), NEVER);
  assert.equal(store._buildFilterClause('field', { $gt: null }), NEVER);
  assert.equal(store._buildFilterClause('field', { $in: [] }), NEVER);
  assert.equal(store._buildFilterClause('field', { $in: 'notarray' }), NEVER);

  // string escaping
  assert.equal(store._buildFilterClause('name', "O'Brien"), "name = 'O''Brien'");

  // column quoting for non-lowercase identifiers
  assert.equal(store._buildFilterClause('Source', 'doc'), '"Source" = \'doc\'');
  assert.equal(store._buildFilterClause('my-field', 'val'), '"my-field" = \'val\'');
});

test('search builds correct WHERE clause with advanced filter operators', async () => {
  const store = new RAGVectorStore();
  const originalTable = store.table;
  const originalInitialized = store.initialized;

  store.initialized = true;
  let capturedWhere = null;
  const fakeRows = [
    { id: '1', content: 'doc', _distance: 0.2, metadata: '{"key":"val"}', source: 's', type: 't', ingestedAt: '2023' }
  ];

  // chainable mock for search
  const chainable = {
    where: function (clause) { capturedWhere = clause; return this; },
    limit: function (k) { return this; },
    toArray: async function () { return fakeRows; }
  };
  store.table = { search: () => chainable };

  try {
    const filter = {
      source: { $ne: 'old' },
      count: { $gte: 1, $lt: 10 },
      type: { $in: ['a', 'b'] }
    };
    const results = await store.search([1, 2], 5, filter);

    // The WHERE clause must contain the individual operator expressions.
    // Order of conditions inside a parenthesised group is not guaranteed.
    assert.ok(capturedWhere.includes("source != 'old'"));
    assert.ok(capturedWhere.includes("count >= 1"));
    assert.ok(capturedWhere.includes("count < 10"));
    assert.ok(capturedWhere.includes("type IN ('a', 'b')"));

    assert.equal(results.length, 1);
    assert.equal(results[0].similarity, 0.8); // 1 - 0.2
    assert.equal(results[0].metadata.key, 'val');
    assert.equal(results[0].pageContent, 'doc');
  } finally {
    store.table = originalTable;
    store.initialized = originalInitialized;
  }
});

test('search does not add WHERE clause when filter is null or empty', async () => {
  const store = new RAGVectorStore();
  const originalTable = store.table;
  const originalInitialized = store.initialized;

  store.initialized = true;
  let whereCalled = false;
  const chainable = {
    where: function () { whereCalled = true; return this; },
    limit: function () { return this; },
    toArray: async function () { return []; }
  };
  store.table = { search: () => chainable };

  try {
    // null filter
    await store.search([1, 2], 5, null);
    assert.equal(whereCalled, false);

    // empty object filter
    whereCalled = false;
    await store.search([1, 2], 5, {});
    assert.equal(whereCalled, false);

    // unsupported operator object matches nothing (no query, empty result)
    whereCalled = false;
    const none = await store.search([1, 2], 5, { source: 'a', field: { foo: 'bar' } });
    assert.deepEqual(none, []);
    assert.equal(whereCalled, false);
  } finally {
    store.table = originalTable;
    store.initialized = originalInitialized;
  }
});

test('deleteByFilter builds correct DELETE clause with advanced operators', async () => {
  const store = new RAGVectorStore();
  const originalTable = store.table;
  const originalInitialized = store.initialized;

  store.initialized = true;
  let deleteClause = null;
  let countCalls = 0;
  store.table = {
    countRows: async () => { countCalls++; return countCalls === 1 ? 10 : 7; },
    delete: async (clause) => { deleteClause = clause; }
  };

  try {
    const filter = { source: { $ne: 'old' }, count: { $gte: 1 } };
    const deleted = await store.deleteByFilter(filter);
    assert.equal(deleted, 3);
    assert.ok(deleteClause.includes("source != 'old'"));
    assert.ok(deleteClause.includes("count >= 1"));
  } finally {
    store.table = originalTable;
    store.initialized = originalInitialized;
  }
});

test('deleteByFilter returns 0 when no valid clauses are built', async () => {
  const store = new RAGVectorStore();
  const originalTable = store.table;
  const originalInitialized = store.initialized;

  store.initialized = true;
  let deleteCalled = false;
  store.table = {
    countRows: async () => 5,
    delete: async () => { deleteCalled = true; }
  };

  try {
    // filter with only unrecognized operators
    const deleted = await store.deleteByFilter({ field: { foo: 'bar' } });
    assert.equal(deleted, 0);
    assert.equal(deleteCalled, false);

    // a valid clause beside an unsupported one must NOT delete by the valid
    // clause alone (that would delete more than the caller asked for)
    const deleted1 = await store.deleteByFilter({ source: 'a', type: { $in: [] } });
    assert.equal(deleted1, 0);
    assert.equal(deleteCalled, false);

    // null filter
    const deleted2 = await store.deleteByFilter(null);
    assert.equal(deleted2, 0);
    assert.equal(deleteCalled, false);
  } finally {
    store.table = originalTable;
    store.initialized = originalInitialized;
  }
});
