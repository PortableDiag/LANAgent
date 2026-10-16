import test from 'node:test';
import assert from 'node:assert/strict';
import { ttsCredits, withinMargin, modelInfo, TTS_TIERS, TTS_DEFAULT_MODEL, TTS_MAX_CHARS } from '../../src/api/external/routes/tts.js';

test('billed per started 1,000 characters, minimum one block', () => {
  assert.equal(ttsCredits(1, 1), 1);
  assert.equal(ttsCredits(1000, 1), 1);
  assert.equal(ttsCredits(1001, 1), 2);
  assert.equal(ttsCredits(TTS_MAX_CHARS, 1), 5);
  assert.equal(ttsCredits(TTS_MAX_CHARS, 3), 15);
  assert.equal(ttsCredits(250, 3), 3);
  assert.equal(ttsCredits(0, 1), null);
  assert.equal(ttsCredits(NaN, 1), null);
});

test('a model is sold only while its live cost leaves margin', () => {
  // 1 credit = $0.01 per 1K chars; the guard allows up to 90% of that
  assert.equal(withinMargin(0.000007, 1), true);   // orpheus $7/1M → $0.007/1K
  assert.equal(withinMargin(0.0000095, 1), false); // $0.0095/1K > $0.009
  assert.equal(withinMargin(0.00002, 3), true);    // eleven flash $0.02/1K vs $0.03
  assert.equal(withinMargin(0.00006, 3), false);   // minimax turbo would lose money
  assert.equal(withinMargin(NaN, 1), false);
});

test('tiers: the default model is standard, unknown models are not sold', () => {
  assert.equal(modelInfo(TTS_DEFAULT_MODEL).tier, 'standard');
  assert.equal(modelInfo('x-ai/grok-voice-tts-1.0').creditsPer1k, 3);
  assert.equal(modelInfo('minimax/speech-2.8-hd'), null);
  for (const t of Object.values(TTS_TIERS)) {
    for (const m of Object.values(t.models)) assert.ok(m.defaultVoice);
  }
});
