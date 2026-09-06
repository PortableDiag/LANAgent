/**
 * A caller's watchdog must never expire before the provider it is waiting on.
 *
 * `analyzeFileWithAI` raced a hard-coded 60s deadline against
 * `providerManager.generateResponse(...)`. HuggingFace's budget for that exact
 * call is 90s — its budget scales with `maxTokens` and is capped at 90s, and it
 * was raised to 90s *for* these self-modification code-generation calls. So the
 * caller always lost the race: it gave up 30s before the provider was even
 * allowed to answer. Any analysis that ran long failed, and no analysis that ran
 * long could ever succeed — a permanent failure wearing the costume of a flaky
 * provider.
 *
 * Production: 54 "AI analysis timeout" failures between 2026-09-02 and 09-06,
 * each paired with a "HuggingFace request timed out after 90000ms" logged 30s
 * later. Not every analysis was lost — the slow tail was: 119 succeeded against
 * 21 lost on 09-05 (15%), 22 against 7 on 09-06 (24%). Every loss also burned a
 * full 60s of the scan window for nothing. ollama's budget is 600s, which the
 * same fixed deadline would truncate tenfold.
 *
 * The invariant these tests pin: whatever the provider says its budget is, the
 * watchdog sits above it. The 60s was not wrong when written — it fell behind
 * when the provider's budget was raised and nothing tied the two together.
 */
import test from 'node:test';
import assert from 'node:assert';
import { HuggingFaceProvider } from '../../src/providers/huggingface.js';
import { BaseProvider } from '../../src/providers/BaseProvider.js';
import { ProviderManager } from '../../src/core/providerManager.js';

// The options analyzeFileWithAI actually sends.
const ANALYSIS_OPTIONS = { maxTokens: 10000, temperature: 0.3, enableWebSearch: false };

// Mirrors the constants in capabilityIncrementalScanner.js.
const MARGIN_MS = 15000;
const MIN_WATCHDOG_MS = 60000;
const watchdogFor = budgetMs =>
  Math.max(Number(budgetMs) > 0 ? Number(budgetMs) : 0, MIN_WATCHDOG_MS) + MARGIN_MS;

const hf = () => {
  const p = new HuggingFaceProvider({ apiKey: 'test-key' });
  p.deactivate?.();
  return p;
};

test('HuggingFace reports the scaled budget for the call the scanner makes', () => {
  assert.strictEqual(hf().getGenerationTimeoutMs(ANALYSIS_OPTIONS), 90000,
    'the 10k-token analysis call is capped at 90s, not the 30s base budget');
});

test('a small chat turn still reports the base budget', () => {
  assert.strictEqual(hf().getGenerationTimeoutMs({ maxTokens: 500 }), 30000,
    'the budget scales with maxTokens — it must not report the cap for every call');
});

test('the watchdog outlives the provider budget it is guarding', () => {
  const budget = hf().getGenerationTimeoutMs(ANALYSIS_OPTIONS);
  assert.ok(watchdogFor(budget) > budget,
    `watchdog ${watchdogFor(budget)}ms must exceed the provider's ${budget}ms`);
});

test('the exact regression: 60s would have lost to the 90s budget', () => {
  const budget = hf().getGenerationTimeoutMs(ANALYSIS_OPTIONS);
  assert.ok(60000 < budget,
    'the old hard-coded deadline was below the provider budget — that was the bug');
  assert.ok(watchdogFor(budget) >= budget + MARGIN_MS,
    'the replacement keeps real headroom so the provider rejects on its own terms first');
});

test('a long-budget provider raises the watchdog rather than being truncated', () => {
  // ollama allows 600s for local CPU inference; the fixed 60s cut it by 10x.
  const ollamaish = new BaseProvider('ollama-like', {});
  ollamaish.timeout = 600000;
  ollamaish.deactivate?.();
  const budget = ollamaish.getGenerationTimeoutMs();
  assert.strictEqual(budget, 600000);
  assert.ok(watchdogFor(budget) > 600000,
    'the watchdog must follow the provider up, not clamp it back down to a fixed floor');
});

test('a provider that cannot describe a budget falls back to the floor', () => {
  const mute = new BaseProvider('mute', {});
  mute.deactivate?.();
  assert.strictEqual(mute.getGenerationTimeoutMs(), null,
    'no configured budget means null, not a fabricated number');
  assert.strictEqual(watchdogFor(null), MIN_WATCHDOG_MS + MARGIN_MS,
    'an undescribed budget keeps the previous behaviour as a lower bound');
});

test('providerManager reports the active provider budget', async () => {
  const pm = new ProviderManager();
  const provider = hf();
  pm.providers.set('huggingface', provider);
  pm.activeProvider = provider;
  assert.strictEqual(await pm.getGenerationTimeoutMs(ANALYSIS_OPTIONS), 90000);
});

test('providerManager reports null rather than throwing when there is no provider', async () => {
  // getCurrentProvider() throws "No active AI provider" on an empty manager. The
  // scanner must still get a watchdog, so this resolves to null and the floor applies.
  const budget = await new ProviderManager().getGenerationTimeoutMs(ANALYSIS_OPTIONS);
  assert.strictEqual(budget, null);
  assert.strictEqual(watchdogFor(budget), MIN_WATCHDOG_MS + MARGIN_MS);
});
