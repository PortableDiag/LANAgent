import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import transactionService from '../../src/services/crypto/transactionService.js';

// Service-level test for the /history filter logic. Route is a thin
// wrapper that just forwards query params, so testing the service
// directly gives full coverage without standing up auth + HTTP.

test('getFilteredHistory builds query from supported filters', async () => {
  const rows = [
    { txHash: '0x1', transactionType: 'stakingClaim', category: 'staking', network: 'bsc', amount: 100, date: new Date('2026-06-05') },
    { txHash: '0x2', transactionType: 'sale',         category: 'bought',  network: 'bsc', amount: 50,  date: new Date('2026-06-04') }
  ];

  let capturedQuery = null;
  const fakeModel = {
    find(q) {
      capturedQuery = q;
      const chain = {
        sort() { return chain; },
        skip() { return chain; },
        limit() { return chain; },
        lean: async () => rows
      };
      return chain;
    },
    countDocuments: async () => 42
  };

  const stub = mock.method(mongoose, 'model', () => fakeModel);
  try {
    const result = await transactionService.getFilteredHistory(
      null,           // address — ignored (not in schema)
      'bsc',
      null,           // status — ignored (not in schema)
      '2026-06-01',
      '2026-06-30',
      10,
      0
    );

    assert.strictEqual(result.total, 42);
    assert.strictEqual(result.limit, 10);
    assert.strictEqual(result.offset, 0);
    assert.deepStrictEqual(result.items, rows);
    assert.strictEqual(capturedQuery.network, 'bsc');
    assert.ok(capturedQuery.date.$gte instanceof Date, 'startDate should be parsed to Date');
    assert.ok(capturedQuery.date.$lte instanceof Date, 'endDate should be parsed to Date');
    // address / status are accepted but not yet schema-backed
    assert.strictEqual(capturedQuery.address, undefined);
    assert.strictEqual(capturedQuery.status, undefined);
  } finally {
    stub.mock.restore();
  }
});

test('getFilteredHistory clamps limit (1..500) and offset (>=0)', async () => {
  const fakeModel = {
    find() {
      const chain = { sort() { return chain; }, skip() { return chain; }, limit() { return chain; }, lean: async () => [] };
      return chain;
    },
    countDocuments: async () => 0
  };
  const stub = mock.method(mongoose, 'model', () => fakeModel);
  try {
    const r1 = await transactionService.getFilteredHistory(null, null, null, null, null, 10000, -5);
    assert.strictEqual(r1.limit, 500, 'limit > 500 clamped to 500');
    assert.strictEqual(r1.offset, 0, 'negative offset clamped to 0');

    const r2 = await transactionService.getFilteredHistory(null, null, null, null, null, 0, 0);
    assert.strictEqual(r2.limit, 1, 'limit < 1 clamped to 1');

    const r3 = await transactionService.getFilteredHistory(null, null, null, null, null, undefined, undefined);
    assert.strictEqual(r3.limit, 50, 'undefined limit defaults to 50');
    assert.strictEqual(r3.offset, 0, 'undefined offset defaults to 0');
  } finally {
    stub.mock.restore();
  }
});

test('getFilteredHistory tolerates invalid date strings', async () => {
  let capturedQuery = null;
  const fakeModel = {
    find(q) {
      capturedQuery = q;
      const chain = { sort() { return chain; }, skip() { return chain; }, limit() { return chain; }, lean: async () => [] };
      return chain;
    },
    countDocuments: async () => 0
  };
  const stub = mock.method(mongoose, 'model', () => fakeModel);
  try {
    await transactionService.getFilteredHistory(null, null, null, 'not-a-date', 'also-not-a-date', 10, 0);
    // No usable dates means no date constraint added at all
    assert.strictEqual(capturedQuery.date, undefined);
  } finally {
    stub.mock.restore();
  }
});
