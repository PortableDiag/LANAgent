// 2026-11-11: each Telegram message sent without replying opened a new topic, and ALICE forgot the conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryManager } from '../../src/core/memoryManager.js';

test('a new topic or a voice note carries on the last 30 minutes; a topic with its own talk stays its own', () => {
  const m = new MemoryManager({});
  m.addContextTurn('7', undefined, 'user', 'make the Master Toilet light bright white');
  assert.equal(m.activeThread('7', 645248), undefined);          // new topic → the voice-note conversation
  m.addContextTurn('7', 645248, 'user', 'do it now');
  assert.equal(m.activeThread('7', 645300), 645248);             // newer new topic → the latest one
  assert.equal(m.activeThread('7', 645248), 645248);
  assert.equal(m.activeThread('7', undefined), undefined);       // its own talk is fresh
  assert.equal(m.activeThread('8', 99), 99);                     // another user: nothing to carry
  m._conversationBuffer.get('7#645248')[0].ts -= 31 * 60 * 1000;
  m._conversationBuffer.get('7')[0].ts -= 31 * 60 * 1000;
  assert.equal(m.activeThread('7', 645400), 645400);             // nothing recent: a fresh conversation
});
