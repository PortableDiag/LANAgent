import test from 'node:test';
import assert from 'node:assert/strict';
import { toRichMarkdown, sendRich, editToRich, richEnabled, resetRichState, RICH_TEXT_LIMIT } from '../../src/interfaces/telegram/richMessage.js';
import { EditStream } from '../../src/interfaces/telegram/draftStream.js';

function fakeTelegram({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async callApi(method, payload) {
      calls.push([method, payload]);
      if (fail) throw new Error(fail);
      return { message_id: 7 };
    },
    async sendMessage(chatId, text, extra) { calls.push(['send', text, extra]); return { message_id: 9 }; },
    async editMessageText(chatId, mid, _i, text, extra) { calls.push(['edit', text, extra]); return true; },
    async deleteMessage() { return true; }
  };
}

test('< is escaped outside code, kept inside code spans and fences', () => {
  // Live 2026-10-16: a bare < started HTML and "a<b and c>d" lost words.
  assert.equal(toRichMarkdown('Use Array<string> and <your-key>; a<b'), 'Use Array&lt;string> and &lt;your-key>; a&lt;b');
  assert.equal(toRichMarkdown('`Array<string>` and ``a<`b`` x<y'), '`Array<string>` and ``a<`b`` x&lt;y');
  assert.equal(toRichMarkdown('```html\n<div>x</div>\n```\nafter <b>'), '```html\n<div>x</div>\n```\nafter &lt;b>');
  assert.equal(toRichMarkdown('~~~~\n<a>\n~~~\n<b>\n~~~~\n<c>'), '~~~~\n<a>\n~~~\n<b>\n~~~~\n&lt;c>');
  // An unclosed backtick is literal, the rest of the line is still escaped
  assert.equal(toRichMarkdown('a ` b <c>'), 'a ` b &lt;c>');
  assert.equal(toRichMarkdown('| a | **b** |\n|--|--|\n| $5 | x |'), '| a | **b** |\n|--|--|\n| $5 | x |');
});

test('sendRich sends model Markdown as rich_message.markdown, in the thread', async () => {
  resetRichState();
  const tg = fakeTelegram();
  const msg = await sendRich(tg, 5, '## Hi <x>', { threadId: 3 });
  assert.deepEqual(msg, { message_id: 7 });
  assert.equal(tg.calls[0][0], 'sendRichMessage');
  assert.deepEqual(tg.calls[0][1], { chat_id: 5, rich_message: { markdown: '## Hi &lt;x>' }, message_thread_id: 3 });
});

test('a one-off failure falls back for that message only', async () => {
  resetRichState();
  assert.equal(await sendRich(fakeTelegram({ fail: 'Bad Request: too many blocks' }), 5, 'x'), null);
  assert.equal(richEnabled(), true);
  assert.equal(await editToRich(fakeTelegram({ fail: 'Bad Request: message to edit not found' }), 5, 1, 'x'), false);
  assert.equal(richEnabled(), true);
});

test('a server without the method turns rich off for the process', async () => {
  resetRichState();
  assert.equal(await sendRich(fakeTelegram({ fail: '404: Not Found' }), 5, 'x'), null);
  assert.equal(richEnabled(), false);
  const tg = fakeTelegram();
  assert.equal(await sendRich(tg, 5, 'x'), null);
  assert.equal(tg.calls.length, 0);
  resetRichState();
});

test('TELEGRAM_RICH_MESSAGES=off, empty text and over-limit text are not sent rich', async () => {
  resetRichState();
  const tg = fakeTelegram();
  process.env.TELEGRAM_RICH_MESSAGES = 'off';
  assert.equal(await sendRich(tg, 5, 'x'), null);
  delete process.env.TELEGRAM_RICH_MESSAGES;
  assert.equal(await sendRich(tg, 5, '  '), null);
  assert.equal(await sendRich(tg, 5, 'y'.repeat(RICH_TEXT_LIMIT + 1)), null);
  assert.equal(tg.calls.length, 0);
});

test('a streamed reply is delivered rich in place, including past 4096 characters', async () => {
  resetRichState();
  const tg = fakeTelegram();
  const s = await new EditStream(tg, 5, { throttleMs: 0 }).start();
  await s.chunk('He', 'He');
  const long = '| a |\n|--|\n' + '| row |\n'.repeat(700);
  assert.ok(long.length > 4096);
  assert.equal(await s.deliver(long), true);
  const [method, payload] = tg.calls.at(-1);
  assert.equal(method, 'editMessageText');
  assert.equal(payload.message_id, 9);
  assert.equal(payload.rich_message.markdown, long);
  assert.deepEqual(payload.reply_markup, { inline_keyboard: [] });
  await s.finish();
});

test('when the rich edit is refused, deliver falls back to legacy Markdown', async () => {
  resetRichState();
  const tg = fakeTelegram();
  tg.callApi = async (m, p) => { tg.calls.push([m, p]); throw new Error('Bad Request: can\'t parse rich message'); };
  const s = await new EditStream(tg, 5, { throttleMs: 0 }).start();
  await s.chunk('He', 'He');
  assert.equal(await s.deliver('**Hi**'), true);
  assert.deepEqual(tg.calls.at(-1), ['edit', '**Hi**', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }]);
  await s.finish();
});
