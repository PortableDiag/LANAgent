import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramInterface } from '../../src/interfaces/telegram/telegram.js';

const speechFor = (text, max) => TelegramInterface.prototype.speechFor.call(TelegramInterface.prototype, text, max);

test('a short reply is spoken in full, without markdown', () => {
  assert.equal(speechFor('**Done.** Sent it to Wayne.'), 'Done. Sent it to Wayne.');
});

test('a long reply speaks its opening and points to the text', () => {
  const thread = 'Here are the latest messages with Wayne. ' + Array.from({ length: 60 }, (_, i) => `Wayne: message number ${i} about the meeting.`).join('\n');
  const said = speechFor(thread);
  assert.ok(said.length < 760, `spoke ${said.length} chars`);
  assert.ok(said.startsWith('Here are the latest messages with Wayne.'));
  assert.ok(said.endsWith('The rest is in the message.'));
});

test('a long reply with no sentence breaks is cut on a word', () => {
  const said = speechFor('word '.repeat(400));
  assert.match(said, /word The rest is in the message\.$/);
});
