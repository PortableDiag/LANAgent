import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramInterface } from '../../src/interfaces/telegram/telegram.js';

const dnsDown = () => Object.assign(new Error('request to https://api.telegram.org/bot…/sendMessage failed, reason: getaddrinfo EAI_AGAIN api.telegram.org'), { code: 'EAI_AGAIN', errno: 'EAI_AGAIN' });

function fakeInterface(failures) {
  const t = Object.create(TelegramInterface.prototype);
  t.authorizedUserId = 1;
  const sent = [];
  t.bot = { telegram: { sendMessage: async (id, text) => { if (failures.length) throw failures.shift()(); sent.push(text); } } };
  return { t, sent };
}

test('only failures that never reached Telegram are retried', () => {
  assert.equal(TelegramInterface.isPreSendNetworkError(dnsDown()), true);
  assert.equal(TelegramInterface.isPreSendNetworkError({ code: 'ECONNREFUSED' }), true);
  assert.equal(TelegramInterface.isPreSendNetworkError({ code: 'ECONNRESET' }), false, 'may have been delivered');
  assert.equal(TelegramInterface.isPreSendNetworkError({ message: "400: Bad Request: can't parse entities" }), false);
});

test('a notice lost to a VPN switch is resent in the background, without holding the caller', async () => {
  const { t, sent } = fakeInterface([dnsDown, dnsDown]);
  let retry;
  t._retryNotificationInBackground = function (sendOnce) {
    retry = TelegramInterface.prototype._retryNotificationInBackground.call(this, sendOnce, [1, 1, 1]);
  };
  assert.equal(await t.sendNotification('stop-loss hit'), false, 'caller still learns the first send failed');
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(sent, ['stop-loss hit']);
});

test('a refusal is not retried', async () => {
  const { t, sent } = fakeInterface([() => Object.assign(new Error('403: Forbidden: bot was blocked by the user'), { code: 403 })]);
  let retried = false;
  t._retryNotificationInBackground = () => { retried = true; };
  assert.equal(await t.sendNotification('x'), false);
  assert.equal(retried, false);
  assert.deepEqual(sent, []);
});
