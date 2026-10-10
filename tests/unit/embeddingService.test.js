import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddingService } from '../../src/services/embeddingService.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('cosineSimilarity: identical, orthogonal, opposite and 45 degrees', () => {
  close(embeddingService.cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  close(embeddingService.cosineSimilarity([1, 0], [0, 1]), 0);
  close(embeddingService.cosineSimilarity([1, 0], [-1, 0]), -1);
  close(embeddingService.cosineSimilarity([1, 0], [1, 1]), Math.SQRT1_2);
  close(embeddingService.cosineSimilarity(new Float32Array([1, 0]), [2, 0]), 1);
});

test('cosineSimilarity: zero vector scores 0; bad input throws', () => {
  assert.equal(embeddingService.cosineSimilarity([0, 0], [1, 1]), 0);
  assert.throws(() => embeddingService.cosineSimilarity([1], [1, 2]), /dimensions must match/);
  assert.throws(() => embeddingService.cosineSimilarity([], []), /must not be empty/);
  assert.throws(() => embeddingService.cosineSimilarity([1, NaN], [1, 2]), TypeError);
  assert.throws(() => embeddingService.cosineSimilarity('ab', [1, 2]), TypeError);
});

test('rankBySimilarity: sorts descending, accepts records, honours topK', () => {
  const far = { id: 'far', embedding: [0, 1] };
  const near = { id: 'near', embedding: [1, 0.1] };
  const ranked = embeddingService.rankBySimilarity([1, 0], [far, near, [1, 0]]);
  assert.deepEqual(ranked.map(r => r.candidate.id ?? 'raw'), ['raw', 'near', 'far']);
  assert.equal(embeddingService.rankBySimilarity([1, 0], [far, near], { topK: 1 })[0].candidate, near);
  assert.equal(embeddingService.rankBySimilarity([1, 0], [far], { topK: 0 }).length, 0);
  assert.throws(() => embeddingService.rankBySimilarity([1, 0], [{ id: 'x' }]), /embedding field/);
  assert.throws(() => embeddingService.rankBySimilarity([1, 0], [far], { topK: -1 }), /topK/);
});

test('compareEmbedding embeds both texts with one model and the same dimensions', async () => {
  const calls = [];
  const original = embeddingService.generateEmbedding;
  embeddingService.generateEmbedding = async (text, opts) => {
    calls.push(opts);
    return text === 'a' ? [1, 0] : [1, 1];
  };
  try {
    const score = await embeddingService.compareEmbedding('a', 'b', { dimensions: 256 });
    close(score, Math.SQRT1_2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].model, calls[1].model);
    assert.equal(calls[0].dimensions, 256);
    await assert.rejects(() => embeddingService.compareEmbedding('a', 5), TypeError);
  } finally {
    embeddingService.generateEmbedding = original;
  }
});

// Token-aware truncation

test('estimateTokenCount returns 0 for non-string or empty', () => {
  assert.equal(embeddingService.estimateTokenCount(null), 0);
  assert.equal(embeddingService.estimateTokenCount(123), 0);
  assert.equal(embeddingService.estimateTokenCount(undefined), 0);
  assert.equal(embeddingService.estimateTokenCount(''), 0);
});

test('estimateTokenCount errs high: never below the word/punctuation count', () => {
  assert.equal(embeddingService.estimateTokenCount('a b c'), 3);          // 3 pieces > ceil(5/3)
  assert.equal(embeddingService.estimateTokenCount('hello, world!'), 5);  // ceil(13/3) > 4 pieces
  assert.equal(embeddingService.estimateTokenCount('你好'), 2);            // one per non-ASCII char
});

test('truncateToTokenLimit throws for unknown model', () => {
  assert.throws(() => embeddingService.truncateToTokenLimit('text', 'nonexistent'), /not found/);
});

test('truncateToTokenLimit returns the original string when within limit', () => {
  const text = 'short text,  with   odd spacing!\n';
  assert.equal(embeddingService.truncateToTokenLimit(text, embeddingService.defaultModel), text);
  // exactly at the limit is unchanged
  const max = embeddingService.models[embeddingService.defaultModel].maxTokens;
  const atLimit = 'abc'.repeat(max);
  assert.equal(embeddingService.estimateTokenCount(atLimit), max);
  assert.equal(embeddingService.truncateToTokenLimit(atLimit, embeddingService.defaultModel), atLimit);
});

test('truncateToTokenLimit returns a fitting PREFIX of the original text', () => {
  const modelId = embeddingService.defaultModel;
  const max = embeddingService.models[modelId].maxTokens;
  const longText = Array.from({ length: 9000 }, (_, i) => `word${i}, `).join('');
  const truncated = embeddingService.truncateToTokenLimit(longText, modelId);
  assert.ok(longText.startsWith(truncated), 'must be a prefix: punctuation/spacing preserved');
  assert.ok(truncated.length < longText.length);
  assert.ok(embeddingService.estimateTokenCount(truncated) <= max);
  assert.ok(truncated.length > longText.length / 4, 'should not over-truncate');
});

test('truncateToTokenLimit handles dense non-ASCII text', () => {
  const modelId = embeddingService.defaultModel;
  const max = embeddingService.models[modelId].maxTokens;
  const cjk = '你好世界'.repeat(5000);
  const truncated = embeddingService.truncateToTokenLimit(cjk, modelId);
  assert.ok(cjk.startsWith(truncated));
  assert.ok(embeddingService.estimateTokenCount(truncated) <= max);
});
