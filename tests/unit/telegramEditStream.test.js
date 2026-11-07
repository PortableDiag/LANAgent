import test from 'node:test';
import assert from 'node:assert/strict';
import { EditStream, NullStream, DraftStream, createReplyStream, handleStopButton } from '../../src/interfaces/telegram/draftStream.js';
import { installConcurrentUpdates, queueKeyOf } from '../../src/interfaces/telegram/updateDispatcher.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fakeTelegram({ markdownFails = false } = {}) {
  const calls = [];
  let id = 100;
  return {
    calls,
    async sendMessage(chatId, text, extra) { calls.push(['send', text, extra]); return { message_id: ++id }; },
    async editMessageText(chatId, mid, _i, text, extra) {
      if (markdownFails && extra?.parse_mode) throw new Error("Bad Request: can't parse entities");
      calls.push(['edit', text, extra]); return true;
    },
    async deleteMessage(chatId, mid) { calls.push(['delete', mid]); return true; },
    async callApi() { return true; }
  };
}

test('default transport is edit; draft only when asked and in a private chat; off disables', () => {
  assert.ok(createReplyStream(fakeTelegram(), 5, {}) instanceof EditStream);
  assert.ok(createReplyStream(fakeTelegram(), 5, { transport: 'draft' }) instanceof DraftStream);
  assert.ok(createReplyStream(fakeTelegram(), -100, { transport: 'draft' }) instanceof EditStream);
  assert.ok(createReplyStream(fakeTelegram(), 5, { transport: 'off' }) instanceof NullStream);
});

test('nothing is sent while thinking; first text is sent with a Stop button, then edited', async () => {
  const tg = fakeTelegram();
  const s = await new EditStream(tg, 5, { throttleMs: 0 }).start();
  await s.status('🔧 web search');
  assert.equal(tg.calls.length, 0);
  await s.chunk('He', 'He');
  await s.chunk('llo', 'Hello');
  assert.equal(tg.calls[0][0], 'send');
  assert.equal(tg.calls[0][1], 'He ▍');
  assert.equal(tg.calls[0][2].reply_markup.inline_keyboard[0][0].callback_data, `stream_stop:${s.id}`);
  assert.equal(tg.calls[1][0], 'edit');
  assert.equal(tg.calls[1][1], 'Hello ▍');
  await s.finish();
});

test('deliver turns the streamed message into the final formatted reply, Stop removed', async () => {
  const tg = fakeTelegram();
  const s = await new EditStream(tg, 5, { throttleMs: 0, rich: false }).start();
  await s.chunk('Hi', 'Hi');
  assert.equal(await s.deliver('**Hi** there'), true);
  const last = tg.calls.at(-1);
  assert.equal(last[0], 'edit');
  assert.equal(last[1], '**Hi** there');
  assert.equal(last[2].parse_mode, 'Markdown');
  assert.deepEqual(last[2].reply_markup, { inline_keyboard: [] });
  assert.equal(tg.calls.filter(c => c[0] === 'send').length, 1, 'one message, not two');
  await s.finish();
});

test('bad Markdown falls back to plain text on the same message', async () => {
  const tg = fakeTelegram({ markdownFails: true });
  const s = await new EditStream(tg, 5, { throttleMs: 0, rich: false }).start();
  await s.chunk('x', 'x');
  assert.equal(await s.deliver('a_b*c'), true);
  assert.equal(tg.calls.at(-1)[1], 'a_b*c');
  assert.equal(tg.calls.at(-1)[2].parse_mode, undefined);
});

test('nothing streamed or a reply over 4096 chars → the caller sends it (long one removed first)', async () => {
  const tg = fakeTelegram();
  const quiet = await new EditStream(tg, 5, { rich: false }).start();
  assert.equal(await quiet.deliver('plugin result'), false);
  const s = await new EditStream(tg, 5, { throttleMs: 0, rich: false }).start();
  await s.chunk('x', 'x');
  assert.equal(await s.deliver('y'.repeat(5000)), false);
  assert.equal(tg.calls.at(-1)[0], 'delete');
});

test('edits are throttled and the newest text still lands (trailing flush)', async () => {
  const tg = fakeTelegram();
  const s = await new EditStream(tg, 5, { throttleMs: 60 }).start();
  await s.chunk('a', 'a');
  for (const t of ['ab', 'abc', 'abcd', 'abcde']) await s.chunk('', t);
  await sleep(150);
  const edits = tg.calls.filter(c => c[0] === 'edit');
  assert.ok(edits.length <= 2, `throttle ignored: ${edits.length}`);
  assert.equal(edits.at(-1)[1], 'abcde ▍');
  await s.finish();
});

test('the Stop button aborts only its own chat\'s stream; later text is not shown', async () => {
  const tg = fakeTelegram();
  const s = await new EditStream(tg, 5, { throttleMs: 0 }).start();
  await s.chunk('par', 'par');
  assert.equal(handleStopButton(`stream_stop:${s.id}`, 6), true);
  assert.equal(s.signal.aborted, false, 'another chat cannot stop it');
  assert.equal(handleStopButton(`stream_stop:${s.id}`, 5), true);
  assert.equal(s.signal.aborted, true);
  const n = tg.calls.length;
  await s.chunk('tial', 'partial');
  assert.equal(tg.calls.length, n);
  assert.equal(await s.deliver('par\n\n⏹ Stopped'), true);
  assert.equal(handleStopButton('menu_main', 5), false);
  await s.finish();
});

test('dispatcher: a slow message does not block a button tap; same-chat messages stay in order', async () => {
  const order = [];
  const bot = {
    async handleUpdate(u) {
      order.push(`start ${u.update_id}`);
      await sleep(u.slow ? 60 : 5);
      order.push(`end ${u.update_id}`);
    }
  };
  installConcurrentUpdates(bot);
  const t0 = Date.now();
  await Promise.all([
    bot.handleUpdate({ update_id: 1, slow: true, message: { chat: { id: 5 }, text: 'long' } }),
    bot.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: 'next' } }),
    bot.handleUpdate({ update_id: 3, callback_query: { data: 'stream_stop:1', message: { chat: { id: 5 } } } })
  ]);
  assert.ok(Date.now() - t0 < 30, 'the polling loop is not held by handlers');
  await sleep(120);
  assert.ok(order.indexOf('end 3') < order.indexOf('end 1'), `tap waited for the slow message: ${order}`);
  assert.ok(order.indexOf('start 2') > order.indexOf('end 1'), `messages reordered: ${order}`);
  assert.equal(queueKeyOf({ callback_query: {} }), null);
  assert.equal(queueKeyOf({ message: { chat: { id: 7 } } }), '7');
});

test('dispatcher: a failing handler does not break the chat queue', async () => {
  const seen = [];
  const bot = { async handleUpdate(u) { seen.push(u.update_id); if (u.update_id === 1) throw new Error('boom'); } };
  installConcurrentUpdates(bot);
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 5 } } });
  await bot.handleUpdate({ update_id: 2, message: { chat: { id: 5 } } });
  await sleep(20);
  assert.deepEqual(seen, [1, 2]);
});

test('dispatcher: a message sent while the chat has been busy for a while runs at once (2026-11-07 lockout)', async () => {
  const order = [];
  const bot = { async handleUpdate(u) { order.push(`start ${u.update_id}`); await sleep(u.slow ? 300 : 5); order.push(`end ${u.update_id}`); } };
  installConcurrentUpdates(bot, { holdMs: 50 });
  bot.handleUpdate({ update_id: 1, slow: true, message: { chat: { id: 9 }, text: 'change my light' } });
  bot.handleUpdate({ update_id: 2, message: { chat: { id: 9 }, text: 'right after' } });
  await sleep(100);
  bot.handleUpdate({ update_id: 3, message: { chat: { id: 9 }, text: 'hello?' } });
  await sleep(40);
  assert.ok(order.includes('end 3'), `the late message waited for the slow one: ${order}`);
  assert.ok(!order.includes('start 2'), `the message sent right after still waits its turn: ${order}`);
  await sleep(350);
  assert.ok(order.indexOf('start 2') > order.indexOf('end 1'));
});
