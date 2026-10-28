/**
 * getConversationContext() feeds the general answer, the plugin chain and follow-up lookups.
 * It read `type: "conversation"` Memory documents that are never written, so it always came back
 * empty: asked "did you really send him my instruction?" right after a text went out, the agent
 * answered blind and denied it (2026-10-19). It now returns the live conversation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryManager } from '../../src/core/memoryManager.js';
import { messageTextRule } from '../../src/api/plugins/textx.js';

test('getConversationContext returns the live conversation, newest first, in the old document shape', async () => {
  const mm = new MemoryManager({});
  mm.addContextTurn('464405461', undefined, 'user', 'Ask Wayne via text if he needs help with Hermes');
  mm.addContextTurn('464405461', undefined, 'assistant', 'Sent to Wayne: "Do you need any help setting up your Hermes instance?"');
  mm.addContextTurn('464405461', undefined, 'user', 'Did you really send him my instruction?');
  const ctx = await mm.getConversationContext('464405461', 10);
  assert.equal(ctx.length, 3);
  assert.equal(ctx[0].content, 'Did you really send him my instruction?', 'newest first, as callers expect');
  assert.equal(ctx[1].metadata.role, 'assistant');
  assert.match(ctx[1].content, /^Sent to Wayne: "Do you need any help/);
  assert.ok(ctx[2].createdAt instanceof Date);
  // Numeric and string ids are one user (Telegram passes a number).
  assert.equal((await mm.getConversationContext(464405461, 2)).length, 2);
  // A Telegram topic is its own conversation.
  mm.addContextTurn('464405461', 9, 'user', 'in the topic');
  assert.deepEqual((await mm.getConversationContext('464405461', 10, 9)).map(c => c.content), ['in the topic']);
});

test('the send-text rule: quoted words exact, a described message written to the recipient, asides left out', () => {
  const rule = messageTextRule('Charles');
  assert.match(rule, /sent from Charles's phone/);
  assert.match(rule, /Only words in quotes are copied exactly/);
  assert.match(rule, /goes in gifSearch, never in the text/);
  assert.match(rule, /addressing them directly/);
  assert.match(rule, /never put it in the text/);
});
