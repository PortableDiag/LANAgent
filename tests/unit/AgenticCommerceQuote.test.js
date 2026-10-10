import test from 'node:test';
import assert from 'node:assert/strict';
import AgenticCommerceQuote from '../../src/models/AgenticCommerceQuote.js';

test('matchQuote atomically matches pending quote', async () => {
  const original = AgenticCommerceQuote.findOneAndUpdate;
  try {
    AgenticCommerceQuote.findOneAndUpdate = async (filter, update, options) => {
      if (filter.paramsHash.$in.includes('hash1') && filter.status.$in.includes('pending')) {
        return { paramsHash: 'hash1', status: 'matched', matchedAt: new Date(), matchedJobId: 'job1' };
      }
      return null;
    };
    const result = await AgenticCommerceQuote.matchQuote('hash1', 'job1');
    assert.equal(result.status, 'matched');
    assert.equal(result.matchedJobId, 'job1');
    assert.ok(result.matchedAt instanceof Date);
  } finally {
    AgenticCommerceQuote.findOneAndUpdate = original;
  }
});

test('matchQuote throws when no pending quote or expired', async () => {
  const original = AgenticCommerceQuote.findOneAndUpdate;
  try {
    AgenticCommerceQuote.findOneAndUpdate = async () => null;
    await assert.rejects(
      () => AgenticCommerceQuote.matchQuote('hash2', 'job2'),
      /No pending quote found/
    );
  } finally {
    AgenticCommerceQuote.findOneAndUpdate = original;
  }
});

test('cancel sets status to cancelled and saves', async () => {
  const quote = new AgenticCommerceQuote({ paramsHash: 'hash', serviceType: 'test' });
  const originalSave = quote.save;
  try {
    quote.save = async function () {
      this.status = 'cancelled';
      return this;
    };
    const saved = await quote.cancel();
    assert.equal(saved.status, 'cancelled');
  } finally {
    quote.save = originalSave;
  }
});

test('isExpired returns true after 48 hours', () => {
  const quote = new AgenticCommerceQuote({ paramsHash: 'hash', serviceType: 'test' });
  quote.createdAt = new Date(Date.now() - 49 * 3600 * 1000); // 49 hours ago
  assert.equal(quote.isExpired(), true);
});

test('isExpired returns false within 48 hours', () => {
  const quote = new AgenticCommerceQuote({ paramsHash: 'hash', serviceType: 'test' });
  quote.createdAt = new Date(Date.now() - 47 * 3600 * 1000);
  assert.equal(quote.isExpired(), false);
});

test('matchQuote matches legacy quotes without status and both hash cases', async () => {
  const original = AgenticCommerceQuote.findOneAndUpdate;
  let seen;
  try {
    AgenticCommerceQuote.findOneAndUpdate = async (filter, update) => {
      seen = { filter, update };
      return { paramsHash: '0xabc', status: 'matched' };
    };
    await AgenticCommerceQuote.matchQuote('0xABC', 'job9');
    assert.deepEqual(seen.filter.paramsHash, { $in: ['0xabc', '0xABC'] });
    assert.deepEqual(seen.filter.status, { $in: ['pending', null] });
    assert.ok(seen.filter.createdAt.$gt instanceof Date);
    assert.equal(seen.update.$set.status, 'matched');
    assert.equal(seen.update.$set.matchedJobId, 'job9');
  } finally {
    AgenticCommerceQuote.findOneAndUpdate = original;
  }
});

test('matchQuote rejects a missing hash without a DB call', async () => {
  const original = AgenticCommerceQuote.findOneAndUpdate;
  let called = false;
  try {
    AgenticCommerceQuote.findOneAndUpdate = async () => { called = true; return null; };
    await assert.rejects(() => AgenticCommerceQuote.matchQuote('', 'job'), /paramsHash is required/);
    assert.equal(called, false);
  } finally {
    AgenticCommerceQuote.findOneAndUpdate = original;
  }
});

test('new quotes default to pending status', () => {
  const quote = new AgenticCommerceQuote({ paramsHash: 'h', serviceType: 'test' });
  assert.equal(quote.status, 'pending');
});
