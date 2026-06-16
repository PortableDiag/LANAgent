import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMetadataFilters } from '../../src/interfaces/web/vectorIntentRoutes.js';

// Sample vector-search result shape (matches what vectorStore.search returns).
const rows = [
  { id: 1, similarity: 0.9, metadata: { category: 'support',  priority: 1, tags: ['urgent'],  source: 'email'  } },
  { id: 2, similarity: 0.8, metadata: { category: 'billing',  priority: 2, tags: ['urgent'],  source: 'chat'   } },
  { id: 3, similarity: 0.7, metadata: { category: 'support',  priority: 3, tags: ['low'],     source: 'email'  } },
  { id: 4, similarity: 0.6, metadata: { category: 'feature',  priority: 5, tags: ['idea'],    source: 'voice'  } }
];

test('null / empty / non-object filter returns input unchanged', () => {
  assert.equal(applyMetadataFilters(rows, null).length, 4);
  assert.equal(applyMetadataFilters(rows, undefined).length, 4);
  assert.equal(applyMetadataFilters(rows, {}).length, 4);
  assert.equal(applyMetadataFilters(rows, 'not-an-object').length, 4);
});

test('direct equality (shorthand) on string field', () => {
  const out = applyMetadataFilters(rows, { category: 'support' });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(r => r.id), [1, 3]);
});

test('$eq and $ne', () => {
  assert.equal(applyMetadataFilters(rows, { category: { $eq: 'billing' } }).length, 1);
  assert.equal(applyMetadataFilters(rows, { category: { $ne: 'support' } }).length, 2);
});

test('$in and $nin', () => {
  assert.equal(applyMetadataFilters(rows, { source: { $in: ['email', 'chat'] } }).length, 3);
  assert.equal(applyMetadataFilters(rows, { source: { $nin: ['voice'] } }).length, 3);
});

test('numeric range operators ($gt/$gte/$lt/$lte)', () => {
  assert.equal(applyMetadataFilters(rows, { priority: { $gte: 2 } }).length, 3);
  assert.equal(applyMetadataFilters(rows, { priority: { $gt: 2 } }).length, 2);
  assert.equal(applyMetadataFilters(rows, { priority: { $lte: 2 } }).length, 2);
  assert.equal(applyMetadataFilters(rows, { priority: { $lt: 3 } }).length, 2);
});

test('numeric ops reject non-numeric field values (no silent coercion)', () => {
  // category is a string — $gt with a number shouldn't accidentally match
  assert.equal(applyMetadataFilters(rows, { category: { $gt: 0 } }).length, 0);
});

test('$regex with $options flag', () => {
  // Case-insensitive — should still match 'support'
  assert.equal(applyMetadataFilters(rows, { category: { $regex: '^SUPP', $options: 'i' } }).length, 2);
  // Without 'i' flag, no match
  assert.equal(applyMetadataFilters(rows, { category: { $regex: '^SUPP' } }).length, 0);
});

test('$regex with invalid pattern returns no match (no throw)', () => {
  // Unterminated group — must not propagate as error
  assert.doesNotThrow(() => applyMetadataFilters(rows, { category: { $regex: '([' } }));
  assert.equal(applyMetadataFilters(rows, { category: { $regex: '([' } }).length, 0);
});

test('multiple fields combine with AND', () => {
  const out = applyMetadataFilters(rows, { category: 'support', priority: { $gte: 2 } });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 3);
});

test('multiple operators on same field combine with AND', () => {
  // priority > 1 AND priority < 5
  const out = applyMetadataFilters(rows, { priority: { $gt: 1, $lt: 5 } });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(r => r.id), [2, 3]);
});

test('unknown operator rejects the row (fail-closed)', () => {
  // $bogus is not a supported operator — must not accidentally pass everything
  assert.equal(applyMetadataFilters(rows, { category: { $bogus: 'support' } }).length, 0);
});

test('missing metadata field treated as undefined', () => {
  // No 'foo' field exists on any row — equality match should find none
  assert.equal(applyMetadataFilters(rows, { foo: 'bar' }).length, 0);
  // ...but $ne against a value that's not undefined matches all
  assert.equal(applyMetadataFilters(rows, { foo: { $ne: 'bar' } }).length, 4);
});

test('results lacking metadata field default to empty object (no crash)', () => {
  const sparse = [{ id: 99, similarity: 0.5 /* no metadata key */ }];
  assert.equal(applyMetadataFilters(sparse, { category: 'support' }).length, 0);
});
