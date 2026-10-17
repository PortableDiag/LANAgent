import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStartupNotice, changelogHeadlines, compareVersions } from '../../src/interfaces/telegram/startupNotice.js';

const CHANGELOG = `# Changelog

## [2.25.518] - 2026-10-16

### Added
- **Email:** waits for a verification email.
- **Samba:** space for every mount.

### Fixed
- **Account sign-up re-check read stale results.** Details.

## [2.25.517] - 2026-10-16

### Changed
- **Pull request notices on Telegram are readable cards.** Details.

## [2.25.516] - 2026-10-16

### Added
- **Text to speech as a paid API service.** Details.
`;

test('versions compare numerically', () => {
  assert.equal(compareVersions('2.25.518', '2.25.99'), 1);
  assert.equal(compareVersions('2.25.5', '2.25.5'), 0);
  assert.equal(compareVersions('2.24.900', '2.25.1'), -1);
});

test('headlines: every version after the last announced one, newest first', () => {
  assert.deepEqual(changelogHeadlines(CHANGELOG, '2.25.516', '2.25.518'), [
    'Email: waits for a verification email', 'Samba: space for every mount', 'Account sign-up re-check read stale results', 'Pull request notices on Telegram are readable cards'
  ]);
  assert.deepEqual(changelogHeadlines(CHANGELOG, '2.25.517', '2.25.518').length, 3);
});

test('a changelog without the running version is stale: no list, not a wrong one', () => {
  assert.equal(changelogHeadlines(CHANGELOG, '2.25.516', '2.25.519'), null);
  assert.equal(changelogHeadlines('', '1', '2'), null);
});

test('plain restart: one short card, no "updated" line', () => {
  const n = formatStartupNotice({ agentName: 'ALICE', version: '2.25.518', previousVersion: '2.25.518', bootSeconds: 151, provider: 'OpenRouter', plugins: 96 });
  assert.match(n.rich, /^### 🟢 ALICE is online/);
  assert.match(n.rich, /\*\*v2\.25\.518\*\* · booted in 2m 31s/);
  assert.match(n.rich, /\| AI \| Plugins \|\n\|---\|---\|\n\| OpenRouter \| 96 \|/);
  assert.ok(!/Updated/.test(n.rich));
  assert.ok(!n.text.includes('**'));
});

test('after an update the card lists what is new; a rollback says so', () => {
  const heads = Array.from({ length: 11 }, (_, i) => `Change ${i + 1}`);
  const n = formatStartupNotice({ agentName: 'DELTA', version: '2.25.518', previousVersion: '2.25.510', headlines: heads });
  assert.match(n.rich, /\*\*Updated from v2\.25\.510\*\*\n\n- Change 1\n/);
  assert.match(n.rich, /- …and 3 more/);
  assert.match(n.text, /Updated from v2\.25\.510:\n• Change 1/);
  const r = formatStartupNotice({ version: '2.25.500', previousVersion: '2.25.518', headlines: ['x'] });
  assert.match(r.rich, /Rolled back from v2\.25\.518/);
  assert.ok(!r.rich.includes('- x'));
});

test('first boot with no record, unknown provider: no table, no update line', () => {
  const n = formatStartupNotice({ version: '1.0.0' });
  assert.match(n.rich, /LANAgent is online/);
  assert.ok(!n.rich.includes('|'));
  assert.ok(!n.text.includes('undefined'));
});
