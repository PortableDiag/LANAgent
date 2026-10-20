import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MultiUserSupport } from '../../src/interfaces/telegram/multiUserSupport.js';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mus-'));
  return path.join(dir, 'conversations.json');
}

test('saved guest conversations reload with numeric keys and real Dates', () => {
  const file = tempFile();
  const a = new MultiUserSupport({}, { conversationsFilePath: file });
  const now = new Date();
  a.conversations.set(12345, { userName: 'Guest', username: 'guest', startTime: now, messageCount: 2, lastMessage: now });
  a.saveConversations();

  const b = new MultiUserSupport({}, { conversationsFilePath: file });
  assert.equal(b.conversations.has(12345), true, 'a known guest must not look new after a restart');
  const conv = b.conversations.get(12345);
  assert.ok(conv.lastMessage instanceof Date);
  assert.equal(conv.lastMessage.getTime(), now.getTime());
  assert.equal(b.getConversationStats().telegramConversations, 1);
});

test('conversations idle for more than 30 days are dropped on load', () => {
  const file = tempFile();
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify([
    [1, { userName: 'Old', messageCount: 1, startTime: old, lastMessage: old }],
    [2, { userName: 'New', messageCount: 1, startTime: recent, lastMessage: recent }],
    'garbage'
  ]));
  const m = new MultiUserSupport({}, { conversationsFilePath: file });
  assert.deepEqual([...m.conversations.keys()], [2]);
});

test('a corrupt file starts empty instead of throwing', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{not json');
  const m = new MultiUserSupport({}, { conversationsFilePath: file });
  assert.equal(m.conversations.size, 0);
});

test('constructing the class registers no process signal handlers', () => {
  const before = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
  new MultiUserSupport({}, { conversationsFilePath: tempFile() });
  assert.equal(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT'), before);
});
