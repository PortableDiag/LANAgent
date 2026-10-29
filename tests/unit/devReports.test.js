/**
 * Bug reports for the developer: the context captured with each report (recent errors, the
 * conversation) and the card written to Trellis.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { recentErrors, recentConversation, cardBody } from '../../src/services/devReports.js';

const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

test('recentErrors keeps only [ERROR] lines from the last few minutes, without stack frames', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devreports-'));
  const file = path.join(dir, 'errors.log');
  const now = Date.now();
  await fs.writeFile(file, [
    `${stamp(now - 20 * 60000)} [ERROR] too old`,
    `${stamp(now - 60000)} [ERROR] recent one`,
    '    at someFrame (file.js:1:1)',
    `${stamp(now - 30000)} [WARN] not an error`,
    `${stamp(now - 10000)} [ERROR] recent two`
  ].join('\n'));
  const out = await recentErrors({ now, file });
  assert.equal(out.length, 2);
  assert.match(out[0], /recent one$/);
  assert.match(out[1], /recent two$/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('recentErrors returns nothing for a missing log', async () => {
  assert.deepEqual(await recentErrors({ file: '/nonexistent/errors.log' }), []);
});

test('a call report uses the call turns, trimmed to the last 20', async () => {
  const turns = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'ALICE' : 'owner', text: `turn ${i}` }));
  const out = await recentConversation({ turns });
  assert.equal(out.length, 20);
  assert.equal(out[0].text, 'turn 5');
});

test('the card holds the words, the conversation, the errors and the metadata', () => {
  const body = cardBody({
    _id: 'abc', text: 'You hung up on me', interface: 'dialx-realtime', callId: '91',
    conversation: [{ role: 'owner', text: 'wait' }], errors: ['07:00:00 boom'],
    version: '2.25.705', model: 'openrouter/x', createdAt: new Date('2026-10-29T15:00:00Z')
  });
  assert.match(body, /^You hung up on me\n/);
  assert.match(body, /owner: wait/);
  assert.match(body, /07:00:00 boom/);
  assert.match(body, /call:: 91/);
  assert.match(body, /version:: 2\.25\.705/);
  assert.match(body, /status:: open/);
});
