/**
 * A VPN exit switch cuts egress for 13-33 s; with the provider lock on, a chat call inside it
 * failed outright (2026-10-09). Connection errors are retried; anything else is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { withConnectionRetry, isConnectionError } from '../../src/providers/openrouter.js';

const sleep = async () => {};

test('a connection error is retried until the call goes through', async () => {
  let n = 0;
  const out = await withConnectionRetry(async () => { if (++n < 4) throw new APIConnectionError({ message: undefined }); return 'ok'; }, { sleep });
  assert.equal(out, 'ok');
  assert.equal(n, 4);
});

test('timeouts and API errors are not retried', async () => {
  assert.equal(isConnectionError(new APIConnectionTimeoutError()), false, 'a timeout may have been billed');
  for (const err of [new APIConnectionTimeoutError(), new APIError(500, {}, 'boom', {})]) {
    let n = 0;
    await assert.rejects(() => withConnectionRetry(async () => { n++; throw err; }, { sleep }));
    assert.equal(n, 1);
  }
});

test('gives up after the wait window', async () => {
  let n = 0;
  await assert.rejects(() => withConnectionRetry(async () => { n++; throw new APIConnectionError({}); }, { sleep, waitMs: 0 }));
  assert.equal(n, 1);
});
