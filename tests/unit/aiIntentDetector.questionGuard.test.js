import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionPickedAsChange } from '../../src/core/aiIntentDetector.js';

test('a question the classifier maps to a change is answered, not run (git.commit, 2026-10-27)', () => {
  const commit = { plugin: 'git', action: 'commit' };
  const send = { plugin: 'textx', action: 'send' };
  assert.equal(questionPickedAsChange('Hey can you see my phone?', commit), true);
  assert.equal(questionPickedAsChange('Do I have any recent texts from Wayne?', send), true);
  assert.equal(questionPickedAsChange('can you commit the changes?', commit), false, 'asks for the change');
  assert.equal(questionPickedAsChange('Can you text mom I am late?', send), false);
  assert.equal(questionPickedAsChange('Alice, could you send Sam the file?', send), false);
  assert.equal(questionPickedAsChange('Send Adam a text', send), false, 'not a question');
  assert.equal(questionPickedAsChange('what is on my phone', { plugin: 'textx', action: 'status' }), false, 'a read');
});

test('a voice note to someone is hinted to textx send (2026-10-28: it asked a clarifying question)', async () => {
  const { AIIntentDetector } = await import('../../src/core/aiIntentDetector.js');
  const d = new AIIntentDetector({ apiManager: { apis: new Map([['textx', { enabled: true }]]) } });
  d.getDynamicIntents = () => ({ 2033: { plugin: 'textx', action: 'send' }, 2034: { plugin: 'textx', action: 'status' } });
  assert.equal(d._regexIntentHint('Send Adam a voice note audio text message reminding him not to blab about Mars'), 2033);
  assert.equal(d._regexIntentHint('tell Sam I got his voice message'), null);
  // 2026-10-28 live test: no "text"/"message" in it, a number for the recipient; it ran voice.test.
  assert.equal(d._regexIntentHint('Send 5550100199 a voice note saying this is a test of ALICE voice notes'), 2033);
  assert.equal(d._regexIntentHint('send me a voice note of that'), null, 'a voice note for the user is not a text');
});

test('system status carries the host: uptime, load, memory and disk (call 73: "operating system stats")', async () => {
  const { hostStats } = await import('../../src/api/plugins/system.js');
  const h = await hostStats(process.cwd());
  assert.ok(h.uptimeHours >= 0 && h.cpus > 0 && h.load.length === 3);
  assert.ok(h.memoryGB.total > 0);
  assert.ok(h.diskGB.total > 0 && h.diskGB.free >= 0);
});

test('system status counts the last hour of errors, so "no errors" is never said blind (2026-10-28)', async () => {
  const { recentErrors } = await import('../../src/api/plugins/system.js');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'errs-'));
  const file = path.join(dir, 'errors.log');
  const at = (minAgo) => { const d = new Date(Date.UTC(2026, 9, 28, 12, 0) - minAgo * 60000); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`; };
  await fs.writeFile(file, [`${at(90)} [ERROR] old one`, `${at(10)} [ERROR] Scraping error for x`, `${at(5)} [ERROR] Scraping error for x`, '    at stack line', `${at(2)} [ERROR] other`].join('\n'));
  const r = await recentErrors(file, { now: Date.UTC(2026, 9, 28, 12, 0) });
  assert.equal(r.count, 3);
  assert.deepEqual(r.top[0], { message: 'Scraping error for x', n: 2 });
  assert.equal((await recentErrors(path.join(dir, 'missing.log'))).unavailable, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a request naming Bots & Borgs goes to the store plugin: buy wording buys, the rest browses (2026-10-28)', async () => {
  const { AIIntentDetector } = await import('../../src/core/aiIntentDetector.js');
  const d = new AIIntentDetector({ apiManager: { apis: new Map([['botsandborgs', { enabled: true }]]) } });
  d.getDynamicIntents = () => ({ 3001: { plugin: 'botsandborgs', action: 'buy' }, 3002: { plugin: 'botsandborgs', action: 'browse' } });
  assert.equal(d._regexIntentHint('hey lanagent go to botsnborgs.com and buy yourself an avatar'), 3001);
  assert.equal(d._regexIntentHint('what does bots & borgs sell?'), 3002);
  assert.equal(d._regexIntentHint('buy me a coffee'), null);
});
