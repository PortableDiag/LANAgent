import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

// The operator's traded symbols live in AUTOPOST_TRADED_SYMBOLS, not in the (published)
// source. Set it the way ALICE's .env does BEFORE the module evaluates its pattern.
process.env.AUTOPOST_TRADED_SYMBOLS = 'SKYNET,CAKE,LINK,UNI';
const { filterSensitiveCommits } = await import('../../src/utils/autoPostFilter.js');

// The auto-post composes its "new capabilities" list from recent commit SUBJECTS, so a
// subject naming the live trading pick publishes it. This guard has been widened seven
// times; the first six each added a MECHANIC by name, which is why each held only until
// the next unnamed one.
//
// The seventh case, 2026-09-21: `feat: add the UNI/USD oracle feed for BSC` passed
// cleanly on the same day the trader was switched onto that token. `uniswap` does not
// match `UNI`, and an oracle-feed commit reads like plumbing rather than trading.
//
// These lock BOTH halves of the fix: the traded universe by symbol, and the shape
// (<TICKER>/USD, oracle/price-feed wording) that is meant to catch the eighth case
// before someone remembers to add a symbol.

const blocked = [
  'feat: add the UNI/USD oracle feed for BSC',
  'fix: an oracle feed with a bad checksum was silently unused for months',
  'feat(crypto): add CAKE fallback',
  'chore: point the price feed at a new aggregator',
  'fix: LINK balance reconciliation',
  'feat: support SOL/USDT pairs',
  'fix: chainlink staleness window',
  'docs: session report for v2.25.319'
];

const allowed = [
  'feat: add dark mode to the web UI',
  'fix: correct a typo in the README',
  'release: v2.25.319 — verify the sender before any mail reaches the model',
  'fix: authenticate the sender before any email reaches the model',
  'perf: cache plugin settings lookups'
];

test('a commit subject naming the traded token never reaches a post', () => {
  const kept = new Set(filterSensitiveCommits(blocked));
  const leaked = blocked.filter(c => kept.has(c));
  assert.deepStrictEqual(leaked, [], `these would have been published: ${leaked.join(' | ')}`);
});

test('ordinary product commits are still postable', () => {
  const kept = new Set(filterSensitiveCommits(allowed));
  const suppressed = allowed.filter(c => !kept.has(c));
  assert.deepStrictEqual(suppressed, [], `over-filtered: ${suppressed.join(' | ')}`);
});

test('the pair shape catches a symbol nobody thought to list', () => {
  // The point of the shape rule: it has to hold when the universe changes and the
  // symbol list is not updated.
  const kept = new Set(filterSensitiveCommits(['feat: add the ARB/USD feed', 'fix: DOGE/USDT routing']));
  assert.strictEqual(kept.size, 0);
});

test('filtering is applied to the whole list, not just the first match', () => {
  const mixed = ['feat: add dark mode to the web UI', 'feat: add the UNI/USD oracle feed for BSC'];
  assert.deepStrictEqual(filterSensitiveCommits(mixed), ['feat: add dark mode to the web UI']);
});

test('the published source names no operator pick', () => {
  const src = fs.readFileSync(new URL('../../src/utils/autoPostFilter.js', import.meta.url), 'utf8');
  for (const sym of ['UNI', 'LINK', 'SIREN']) {
    assert.doesNotMatch(src, new RegExp(`\\b${sym}\\b`), `${sym} is hardcoded in a file that syncs to the public repo`);
  }
});

test('trading-indicator module names in a PR squash subject are filtered (2026-10-09)', async () => {
  const { filterSensitiveCommits } = await import('../../src/utils/autoPostFilter.js');
  assert.deepEqual(filterSensitiveCommits(['🚀 [ALICE] enhance_plugin_features: TechnicalIndicators.js (#2646)', 'add MACD and RSI crossover', 'moving average on daily closes']), []);
  assert.equal(filterSensitiveCommits(['2.25.500: scrapes and chat calls ride out a VPN exit switch']).length, 1);
});
