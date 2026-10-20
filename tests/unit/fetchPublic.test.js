import test, { mock } from 'node:test';
import axios from 'axios';
import assert from 'node:assert/strict';
import { fetchPublic } from '../../src/services/webtools/fetchPublic.js';

test('rejects immediately when the caller has already cancelled', async () => {
  const signal = { aborted: true };

  await assert.rejects(
    fetchPublic('https://example.com/', { signal }),
    error => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.code, 'ERR_CANCELED');
      assert.equal(error.message, 'request aborted');
      return true;
    }
  );
});

test('rejects immediately when the end-to-end deadline has expired', async () => {
  await assert.rejects(
    fetchPublic('https://example.com/', { deadlineMs: 0 }),
    error => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.code, 'ETIMEDOUT');
      assert.equal(error.message, 'request deadline exceeded');
      return true;
    }
  );
});

test('supports totalTimeout as the deadline alias', async () => {
  await assert.rejects(
    fetchPublic('https://example.com/', { totalTimeout: 0 }),
    error => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.code, 'ETIMEDOUT');
      return true;
    }
  );
});

test('rejects invalid deadline values', async () => {
  await assert.rejects(
    fetchPublic('https://example.com/', { deadlineMs: -1 }),
    error => {
      assert.equal(error.name, 'RangeError');
      assert.match(error.message, /non-negative finite number/);
      return true;
    }
  );

  await assert.rejects(
    fetchPublic('https://example.com/', { totalTimeout: Infinity }),
    error => {
      assert.equal(error.name, 'RangeError');
      assert.match(error.message, /non-negative finite number/);
      return true;
    }
  );
});

// IP-literal URLs skip DNS in assertPublicUrl; axios.get is stubbed so no network is used.
const PUBLIC = 'http://93.184.215.14/';
// AbortSignal.timeout() timers are unref'd; keep the loop alive while a test waits on one.
const keepAlive = () => setInterval(() => {}, 1000);

test('without signal or deadline the request options are unchanged', async () => {
  const get = mock.method(axios, 'get', async () => ({ status: 200, data: 'ok', headers: {} }));
  try {
    const res = await fetchPublic(PUBLIC);
    assert.equal(res.data, 'ok');
    const opts = get.mock.calls[0].arguments[1];
    assert.equal(opts.timeout, 20000);
    assert.equal(opts.signal, undefined);
  } finally {
    mock.restoreAll();
  }
});

test('deadline caps the per-hop timeout and aborts a hop that outlives it', async () => {
  let seen;
  mock.method(axios, 'get', (url, opts) => {
    seen = opts;
    // Never resolves on its own: only the deadline signal can end it.
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('canceled'))));
  });
  const keep = keepAlive();
  try {
    const started = Date.now();
    await assert.rejects(fetchPublic(PUBLIC, { deadlineMs: 50 }), err => err.name === 'TimeoutError');
    assert.ok(Date.now() - started < 2000);
    assert.ok(seen.timeout <= 50 && seen.timeout >= 1);
  } finally {
    clearInterval(keep);
    mock.restoreAll();
  }
});

test('caller abort mid-request surfaces as AbortError', async () => {
  const ctrl = new AbortController();
  mock.method(axios, 'get', (url, opts) => {
    setTimeout(() => ctrl.abort(), 5);
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('canceled'))));
  });
  const keep = keepAlive();
  try {
    await assert.rejects(fetchPublic(PUBLIC, { signal: ctrl.signal }), err => err.name === 'AbortError');
  } finally {
    clearInterval(keep);
    mock.restoreAll();
  }
});

test('redirects still go through assertPublicUrl', async () => {
  mock.method(axios, 'get', async () => ({ status: 302, data: '', headers: { location: 'http://127.0.0.1/admin' } }));
  try {
    await assert.rejects(fetchPublic(PUBLIC, { deadlineMs: 1000 }));
  } finally {
    mock.restoreAll();
  }
});

test('a 503 is returned as-is when retries are off (the default)', async () => {
  const get = mock.method(axios, 'get', async () => ({ status: 503, data: 'busy', headers: {} }));
  try {
    const res = await fetchPublic(PUBLIC);
    assert.equal(res.status, 503);
    assert.equal(get.mock.callCount(), 1);
  } finally {
    mock.restoreAll();
  }
});

test('maxRetries retries a 503 then returns the success', async () => {
  let n = 0;
  const get = mock.method(axios, 'get', async () => (++n < 3
    ? { status: 503, data: '', headers: {} }
    : { status: 200, data: 'ok', headers: {} }));
  try {
    const res = await fetchPublic(PUBLIC, { maxRetries: 3, retryDelay: 1 });
    assert.equal(res.status, 200);
    assert.equal(get.mock.callCount(), 3);
  } finally {
    mock.restoreAll();
  }
});

test('exhausted retries hand back the last 5xx response, not a throw', async () => {
  const get = mock.method(axios, 'get', async () => ({ status: 502, data: '', headers: {} }));
  try {
    const res = await fetchPublic(PUBLIC, { maxRetries: 2, retryDelay: 1 });
    assert.equal(res.status, 502);
    assert.equal(get.mock.callCount(), 3);
  } finally {
    mock.restoreAll();
  }
});

test('a 404 is never retried', async () => {
  const get = mock.method(axios, 'get', async () => ({ status: 404, data: '', headers: {} }));
  try {
    const res = await fetchPublic(PUBLIC, { maxRetries: 3, retryDelay: 1 });
    assert.equal(res.status, 404);
    assert.equal(get.mock.callCount(), 1);
  } finally {
    mock.restoreAll();
  }
});

test('a transient network error is retried; a non-transient one is thrown at once', async () => {
  let n = 0;
  const get = mock.method(axios, 'get', async () => {
    if (++n === 1) { const e = new Error('reset'); e.code = 'ECONNRESET'; throw e; }
    return { status: 200, data: 'ok', headers: {} };
  });
  try {
    const res = await fetchPublic(PUBLIC, { maxRetries: 1, retryDelay: 1 });
    assert.equal(res.status, 200);
    assert.equal(get.mock.callCount(), 2);
  } finally {
    mock.restoreAll();
  }
  const get2 = mock.method(axios, 'get', async () => { throw new Error('bad certificate'); });
  try {
    await assert.rejects(fetchPublic(PUBLIC, { maxRetries: 3, retryDelay: 1 }), /bad certificate/);
    assert.equal(get2.mock.callCount(), 1);
  } finally {
    mock.restoreAll();
  }
});

test('a retry wait that would cross the deadline is not taken', async () => {
  const get = mock.method(axios, 'get', async () => ({ status: 503, data: '', headers: {} }));
  try {
    const started = Date.now();
    const res = await fetchPublic(PUBLIC, { maxRetries: 3, retryDelay: 5000, deadlineMs: 1000 });
    assert.equal(res.status, 503);
    assert.equal(get.mock.callCount(), 1);
    assert.ok(Date.now() - started < 1000);
  } finally {
    mock.restoreAll();
  }
});

test('maxRetries rejects a negative or fractional value', async () => {
  await assert.rejects(fetchPublic(PUBLIC, { maxRetries: -1 }), RangeError);
  await assert.rejects(fetchPublic(PUBLIC, { maxRetries: 1.5 }), RangeError);
});
