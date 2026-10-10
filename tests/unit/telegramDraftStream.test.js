import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftStream, EditStream, handleStopUpdate, clip, progressBar } from '../../src/interfaces/telegram/draftStream.js';
import { styleReplyMarkup, installButtonStyles, styleFor } from '../../src/interfaces/telegram/buttonStyle.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fakeTelegram({ draftsWork = true } = {}) {
  const calls = [];
  return {
    calls,
    drafts: () => calls.filter(c => c.method === 'sendMessageDraft').map(c => c.payload),
    async callApi(method, payload) {
      calls.push({ method, payload });
      if (method === 'sendMessageDraft' && !draftsWork) {
        const e = new Error('Bad Request: method not found'); e.response = { error_code: 400 }; throw e;
      }
      return true;
    },
    async sendMessage(chatId, text) { calls.push({ method: 'sendMessage', payload: { chatId, text } }); return { message_id: 77, text }; },
    async editMessageText(chatId, id, _i, text) { calls.push({ method: 'editMessageText', payload: { id, text } }); return true; },
    async deleteMessage(chatId, id) { calls.push({ method: 'deleteMessage', payload: { id } }); return true; }
  };
}

test('start shows the native "Thinking…" draft (empty text) — no message sent', async () => {
  const tg = fakeTelegram();
  const d = await new DraftStream(tg, 5, { refreshMs: 0 }).start();
  assert.equal(d.mode, 'draft');
  assert.deepEqual(tg.drafts()[0], { chat_id: 5, draft_id: d.draftId, text: '' });
  assert.equal(tg.calls.some(c => c.method === 'sendMessage'), false);
  await d.finish();
});

test('status → streamed text → complete, all on one draft id; stream carries a Stop button', async () => {
  const tg = fakeTelegram();
  const d = await new DraftStream(tg, 5, { throttleMs: 0, refreshMs: 0 }).start();
  await d.status('🔧 web search');
  await d.chunk('Hel', 'Hel');
  await d.chunk('lo', 'Hello');
  await d.complete('Hello there');
  await d.finish();
  const drafts = tg.drafts();
  assert.ok(drafts.every(p => p.draft_id === d.draftId));
  assert.equal(drafts[1].text, '🔧 web search');
  assert.equal(drafts[1].can_stop, undefined, 'no Stop button while a tool runs');
  const streamed = drafts.find(p => p.text === 'Hello');
  assert.equal(streamed.can_stop, true);
  assert.equal(streamed.keep_on_stop, true);
  assert.equal(drafts.at(-1).text, 'Hello there');
});

test('status updates stop once the answer is streaming', async () => {
  const tg = fakeTelegram();
  const d = await new DraftStream(tg, 5, { throttleMs: 0, refreshMs: 0 }).start();
  await d.chunk('A', 'A');
  await d.status('🔧 late tool');
  assert.equal(tg.drafts().some(p => p.text === '🔧 late tool'), false);
  await d.finish();
});

test('throttled chunks still show the newest text (trailing flush)', async () => {
  const tg = fakeTelegram();
  const d = await new DraftStream(tg, 5, { throttleMs: 40, refreshMs: 0 }).start();
  await d.chunk('a', 'a');
  await d.chunk('b', 'ab');
  await d.chunk('c', 'abc');
  await sleep(80);
  assert.equal(tg.drafts().at(-1).text, 'abc');
  assert.ok(tg.drafts().length <= 4, `throttle ignored: ${tg.drafts().length} drafts`);
  await d.finish();
});

test('drafts refused → falls back to a status message, edited, then deleted', async () => {
  const tg = fakeTelegram({ draftsWork: false });
  const d = await new DraftStream(tg, 5, { refreshMs: 0 }).start();
  assert.equal(d.mode, 'message');
  await d.status('🔧 working');
  await d.chunk('x', 'x');
  await d.finish();
  const methods = tg.calls.map(c => c.method);
  assert.deepEqual(methods, ['sendMessageDraft', 'sendMessage', 'editMessageText', 'deleteMessage']);
});

test('Stop: the stop update aborts the signal and later chunks are not drafted', async () => {
  const tg = fakeTelegram();
  const d = await new DraftStream(tg, 5, { throttleMs: 0, refreshMs: 0 }).start();
  await d.chunk('par', 'par');
  assert.equal(handleStopUpdate({ stopped_message_generation: { chat: { id: 5 }, draft_id: d.draftId } }), true);
  assert.equal(d.stopped, true);
  assert.equal(d.signal.aborted, true);
  const n = tg.drafts().length;
  await d.chunk('tial', 'partial');
  await d.complete('partial');
  assert.equal(tg.drafts().length, n);
  await d.finish();
});

test('a stop for another chat or a finished draft aborts nothing', async () => {
  const tg = fakeTelegram();
  const d = await new DraftStream(tg, 5, { refreshMs: 0 }).start();
  handleStopUpdate({ stopped_message_generation: { chat: { id: 6 }, draft_id: d.draftId } });
  assert.equal(d.signal.aborted, false);
  await d.finish();
  handleStopUpdate({ stopped_message_generation: { chat: { id: 5 }, draft_id: d.draftId } });
  assert.equal(d.signal.aborted, false);
  assert.equal(handleStopUpdate({ message: { text: 'hi' } }), false);
});

test('a slow step re-sends the draft before its 30s lifetime runs out', async () => {
  const tg = fakeTelegram();
  const d = await new DraftStream(tg, 5, { refreshMs: 30 }).start();
  await d.status('🔧 long tool');
  const n = tg.drafts().length;
  await sleep(90);
  assert.ok(tg.drafts().length > n, 'refreshed');
  assert.equal(tg.drafts().at(-1).text, '🔧 long tool');
  await d.finish();
  const m = tg.drafts().length;
  await sleep(60);
  assert.equal(tg.drafts().length, m, 'no refresh after finish');
});

test('clip keeps drafts within 4096 characters', () => {
  assert.equal(clip('x'.repeat(5000)).length, 4096);
  assert.equal(clip('short'), 'short');
});

test('buttons: ✅ is green, ❌/🗑 red, others and explicit styles untouched', () => {
  assert.equal(styleFor('✅ Approve'), 'success');
  assert.equal(styleFor('🗑 Reject'), 'danger');
  assert.equal(styleFor('❌ Cancel'), 'danger');
  assert.equal(styleFor('⚙️ Settings'), null);
  const markup = { inline_keyboard: [[{ text: '✅ Approve', callback_data: 'a' }, { text: '❌ Deny', callback_data: 'd' }], [{ text: '⚙️ More', callback_data: 'm' }, { text: '✅ Keep', callback_data: 'k', style: 'primary' }]] };
  const out = styleReplyMarkup(markup);
  assert.equal(out.inline_keyboard[0][0].style, 'success');
  assert.equal(out.inline_keyboard[0][1].style, 'danger');
  assert.equal(out.inline_keyboard[1][0].style, undefined);
  assert.equal(out.inline_keyboard[1][1].style, 'primary');
  assert.equal(markup.inline_keyboard[0][0].style, undefined, 'input not mutated');
  const plain = { inline_keyboard: [[{ text: 'Menu', callback_data: 'x' }]] };
  assert.equal(styleReplyMarkup(plain), plain, 'unchanged markup returned as is');
  const str = JSON.stringify(markup);
  assert.equal(JSON.parse(styleReplyMarkup(str)).inline_keyboard[0][0].style, 'success');
});

test('installButtonStyles styles every outgoing keyboard once', async () => {
  const seen = [];
  const tg = { async callApi(method, payload) { seen.push(payload); return true; } };
  installButtonStyles(tg);
  installButtonStyles(tg);
  await tg.callApi('sendMessage', { text: 'x', reply_markup: { inline_keyboard: [[{ text: '✅ Yes', callback_data: 'y' }]] } });
  await tg.callApi('sendMessage', { text: 'no keyboard' });
  assert.equal(seen[0].reply_markup.inline_keyboard[0][0].style, 'success');
  assert.deepEqual(seen[1], { text: 'no keyboard' });
});

test('progressBar: ten cells, clamped, rounded; non-numeric → empty', () => {
  assert.equal(progressBar(0), '░░░░░░░░░░ 0%');
  assert.equal(progressBar(34, 'indexing'), '███░░░░░░░ indexing 34%');
  assert.equal(progressBar(100), '██████████ 100%');
  assert.equal(progressBar(150), '██████████ 100%');
  assert.equal(progressBar(-5), '░░░░░░░░░░ 0%');
  assert.equal(progressBar(NaN), '');
  assert.equal(progressBar(undefined), '');
  assert.equal(progressBar(null), '');
  assert.equal(progressBar('abc'), '');
});

test('DraftStream.progress shows the bar as the status draft, and stops once text streams', async () => {
  const tg = fakeTelegram();
  const d = await new DraftStream(tg, 5, { throttleMs: 0, refreshMs: 0 }).start();
  await d.progress(50, 'step');
  assert.equal(tg.drafts().at(-1).text, '█████░░░░░ step 50%');
  await d.progress(NaN);
  assert.equal(tg.drafts().length, 2, 'non-numeric percent sends nothing');
  await d.chunk('Hi', 'Hi');
  const n = tg.drafts().length;
  await d.progress(90);
  assert.equal(tg.drafts().length, n, 'no progress over streamed text');
  await d.finish();
});

test('EditStream: status/progress send nothing before answer text (unchanged design)', async () => {
  const tg = fakeTelegram();
  const e = await new EditStream(tg, 5, { throttleMs: 0 }).start();
  await e.status('🔧 web search');
  await e.progress(40, 'step');
  assert.equal(tg.calls.length, 0);
});
