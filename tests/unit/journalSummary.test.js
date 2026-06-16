import test from 'node:test';
import assert from 'node:assert/strict';
import JournalPlugin from '../../src/api/plugins/journal.js';
import { Journal } from '../../src/models/Journal.js';

// A minimal stub agent: no providerManager, so the plugin must use the
// honest deterministic summary path (never a faked "AI" summary).
function makePlugin() {
  return new JournalPlugin({ /* no providerManager, no memoryManager */ });
}

test('buildDeterministicSummary reports real stats and labels itself honestly', () => {
  const plugin = makePlugin();
  const journal = {
    entries: [{ content: 'a' }, { content: 'b' }, { content: 'c' }],
    tags: ['work', 'goals'],
    metadata: { totalWordCount: 12 },
    getFullText() {
      return 'Started the day planning. Made good progress on the project. Wrapped up tired but satisfied.';
    }
  };

  const summary = plugin.buildDeterministicSummary(journal);

  // Honest label, not "AI"
  assert.ok(summary.startsWith('Auto-summary:'), 'should be labeled as auto-summary');
  assert.ok(!/\bAI\b/i.test(summary), 'must not claim to be AI');

  // Real stats are present
  assert.ok(summary.includes('3 entries'), 'entry count');
  assert.ok(summary.includes('12 words'), 'word count');
  assert.ok(summary.includes('tags: work, goals'), 'tags');

  // First and last sentences anchor the excerpt
  assert.ok(summary.includes('Started the day planning.'), 'first sentence');
  assert.ok(summary.includes('Wrapped up tired but satisfied.'), 'last sentence');
});

test('buildDeterministicSummary handles single entry and empty text', () => {
  const plugin = makePlugin();

  const single = plugin.buildDeterministicSummary({
    entries: [{ content: 'x' }],
    tags: [],
    metadata: { totalWordCount: 5 },
    getFullText() { return 'Just one thought today.'; }
  });
  assert.ok(single.includes('1 entry'), 'singular wording');
  assert.ok(single.includes('Opened with:'), 'shows the single sentence');

  const empty = plugin.buildDeterministicSummary({
    entries: [],
    tags: [],
    metadata: { totalWordCount: 0 },
    getFullText() { return ''; }
  });
  assert.ok(empty.startsWith('Auto-summary:'), 'still honest when empty');
  assert.ok(empty.includes('0 entries'), 'zero entries');
});

test('Journal.close stores the precomputed summary passed by the plugin', () => {
  // Exercise the close() contract without a live DB by stubbing save().
  const journal = new Journal({ userId: 'u1', title: 'T', status: 'active' });
  journal.save = async () => journal; // avoid hitting MongoDB

  const result = journal.close('Auto-summary: 2 entries, 4 words.');

  assert.equal(journal.status, 'closed');
  assert.equal(journal.summary, 'Auto-summary: 2 entries, 4 words.');
  assert.ok(journal.metadata.closedAt instanceof Date);
  assert.ok(result && typeof result.then === 'function', 'close() returns the save() promise');
});
