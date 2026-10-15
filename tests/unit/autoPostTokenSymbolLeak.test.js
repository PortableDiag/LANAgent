import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

// The operator's traded symbols live in AUTOPOST_TRADED_SYMBOLS, not in the (published)
// source. Set it the way ALICE's .env does BEFORE the module evaluates its pattern.
// PLACEHOLDER tickers: this file syncs to the public repo, so it must not carry the real
// list either (it did until 2026-10-14).
const SYMBOLS = ['ZQXA', 'QRBT', 'PLMK'];
process.env.AUTOPOST_TRADED_SYMBOLS = SYMBOLS.join(',');
const { filterSensitiveCommits } = await import('../../src/utils/autoPostFilter.js');

// The auto-post composes its "new capabilities" list from recent commit SUBJECTS, so a
// subject naming the live trading pick publishes it. This guard has been widened seven
// times; the first six each added a MECHANIC by name, which is why each held only until
// the next unnamed one.
//
// The seventh case, 2026-09-21: `feat: add the <TICKER>/USD oracle feed for BSC` passed
// cleanly on the same day the trader was switched onto that token. Nothing matched the
// bare ticker, and an oracle-feed commit reads like plumbing rather than trading.
//
// These lock BOTH halves of the fix: the traded universe by symbol, and the shape
// (<TICKER>/USD, oracle/price-feed wording) that is meant to catch the eighth case
// before someone remembers to add a symbol.

const blocked = [
  'feat: add the ZQXA/USD oracle feed for BSC',
  'fix: an oracle feed with a bad checksum was silently unused for months',
  'feat: add QRBT fallback',
  'chore: point the price feed at a new aggregator',
  'fix: PLMK balance reconciliation',
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
  const mixed = ['feat: add dark mode to the web UI', 'feat: add the ZQXA/USD oracle feed for BSC'];
  assert.deepStrictEqual(filterSensitiveCommits(mixed), ['feat: add dark mode to the web UI']);
});

test('the published source takes the picks from env and hardcodes no ticker list', () => {
  const src = fs.readFileSync(new URL('../../src/utils/autoPostFilter.js', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.AUTOPOST_TRADED_SYMBOLS/);
  // The only literal list allowed is the generic base set (chain natives + stablecoins).
  const lists = src.match(/\[\s*'[A-Z0-9]{2,12}'(?:\s*,\s*'[A-Z0-9]{2,12}')+\s*\]/g) || [];
  assert.deepStrictEqual(lists, ["['ETH', 'BNB', 'WBNB', 'USDT', 'USDC', 'MATIC']"]);
});

test('trading-indicator module names in a PR squash subject are filtered (2026-10-09)', async () => {
  const { filterSensitiveCommits } = await import('../../src/utils/autoPostFilter.js');
  assert.deepEqual(filterSensitiveCommits(['🚀 [ALICE] enhance_plugin_features: TechnicalIndicators.js (#2646)', 'add MACD and RSI crossover', 'moving average on daily closes']), []);
  assert.equal(filterSensitiveCommits(['2.25.500: scrapes and chat calls ride out a VPN exit switch']).length, 1);
});

test('LP as a camelCase file-name prefix is filtered (LPPosition.js passed on 2026-10-14)', () => {
  const subjects = [
    '🚀 [ALICE] upgrade_core_capabilities: LPPosition.js (#2668)',
    'refactor lpManager refresh',
    'help text cleanup'
  ];
  assert.deepEqual(filterSensitiveCommits(subjects), ['help text cleanup']);
});
