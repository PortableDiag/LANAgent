import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPrNotice, formatDeployNotice, formatSelfModError, typeLabel, repoPath } from '../../src/interfaces/telegram/prNotice.js';

test('a PR notice reads as a card, with the link as a button', () => {
  const n = formatPrNotice({
    agentName: 'ALICE',
    type: 'upgrade_core_capabilities',
    file: '/root/lanagent-repo/src/models/ComputeJob.js',
    description: 'Add atomic status transitions (pending → running → completed/failed).',
    capabilities: ['Valid lifecycle only'],
    priority: 'high',
    impact: 'major',
    safeForProduction: false,
    branch: 'auto-improve/alice/x',
    prUrl: 'https://github.com/o/r/pull/2684',
    prNumber: 2684
  });
  assert.match(n.rich, /^### 🛠️ ALICE opened pull request #2684/);
  assert.match(n.rich, /\*\*Core capability upgrade\*\* · `src\/models\/ComputeJob\.js`/);
  assert.match(n.rich, /\| Priority \| Impact \| Risk \|\n\|---\|---\|---\|\n\| high \| major \| ⚠️ Needs review \|/);
  assert.match(n.rich, /- Valid lifecycle only/);
  // plain fallback: nothing escaped, nothing to escape
  assert.ok(!n.text.includes('\\'));
  assert.ok(!n.text.includes('**'));
  assert.match(n.text, /\(pending → running → completed\/failed\)/);
  assert.deepEqual(n.replyMarkup, { inline_keyboard: [[{ text: 'Open PR #2684', url: 'https://github.com/o/r/pull/2684' }]] });
});

test('no URL, no button; no fields, no table', () => {
  const n = formatPrNotice({ type: 'deployment' });
  assert.equal(n.replyMarkup, undefined);
  assert.ok(!n.rich.includes('|'));
  assert.ok(!n.text.includes('undefined'));
});

test('labels and paths', () => {
  assert.equal(typeLabel('extend_plugin_apis'), 'Plugin API extension');
  assert.equal(typeLabel('some_new_kind'), 'Some new kind');
  assert.equal(repoPath('/root/lanagent-repo/src/api/plugins/vpn.js'), 'src/api/plugins/vpn.js');
  assert.equal(repoPath('src/a.js'), 'src/a.js');
});

test('deploy and error notices', () => {
  const d = formatDeployNotice({ agentName: 'DELTA', files: ['src/a.js', 'src/b.js'] });
  assert.match(d.rich, /^### 📦 DELTA deployed 2 merged files/);
  assert.match(d.rich, /- `src\/a\.js`/);
  const b = formatDeployNotice({ blocked: true, files: Array.from({ length: 12 }, (_, i) => `src/f${i}.js`) });
  assert.match(b.text, /rolled back/);
  assert.match(b.text, /…and 2 more/);
  const e = formatSelfModError({ error: 'Code validation failed: ```x```' });
  assert.ok(!/```x```/.test(e.rich));
  assert.match(e.text, /No pull request was opened/);
});
