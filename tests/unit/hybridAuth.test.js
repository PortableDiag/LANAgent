import test from 'node:test';
import assert from 'node:assert/strict';
import { hybridAuth } from '../../src/api/external/middleware/hybridAuth.js';

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test('selects the middleware chain for each authentication policy', () => {
  assert.equal(hybridAuth('svc', 2, { policy: 'credit-only' }).length, 2);
  assert.equal(hybridAuth('svc', 2, { policy: 'legacy-only' }).length, 1);
  assert.equal(hybridAuth('svc', 2, { policy: 'either' }).length, 3);
  assert.equal(hybridAuth('svc', 2).length, 3, 'default policy is either');
});

test('rejects unsupported policies, including the removed "both" mode', () => {
  for (const policy of ['unsupported', 'both']) {
    assert.throws(
      () => hybridAuth('svc', 2, { policy }),
      { name: 'TypeError', message: `Unsupported hybrid authentication policy: ${policy}` }
    );
  }
});

test('credit-only returns 401 when no API key or JWT is supplied', async () => {
  const [auth] = hybridAuth('svc', 2, { policy: 'credit-only' });
  const res = fakeRes();
  let nextCalled = false;
  await auth({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
});

test('legacy-only ignores a prior credit debit and still requires legacy auth', async () => {
  const [legacy] = hybridAuth('svc', 2, { policy: 'legacy-only' });
  const outcome = await new Promise((resolve) => {
    const res = fakeRes();
    res.json = function json(payload) { this.body = payload; resolve({ res: this }); return this; };
    // creditsPaid must NOT bypass legacy-only; without X-Agent-Id externalAuth rejects.
    const req = { headers: {}, creditsPaid: true, ip: '127.0.0.1', socket: {}, app: { get() {} } };
    legacy(req, res, (err) => resolve({ next: true, err }));
  });
  assert.equal(outcome.next, undefined, 'must not reach the route handler');
  assert.equal(outcome.res.statusCode, 401);
  assert.match(outcome.res.body.error, /X-Agent-Id/);
});

test('static numeric cost still yields the plain creditDebit chain', () => {
  assert.equal(hybridAuth('svc', 2, { policy: 'credit-only' }).length, 2);
  // No wallet: the debit step passes through untouched.
  const [, debit] = hybridAuth('svc', 2, { policy: 'credit-only' });
  let called = false;
  return Promise.resolve(debit({ headers: {} }, fakeRes(), () => { called = true; }))
    .then(() => assert.equal(called, true));
});

test('dynamic cost is not evaluated without a credit wallet', async () => {
  let evaluated = false;
  const [, debit] = hybridAuth('svc', () => { evaluated = true; return 3; }, { policy: 'either' });
  let nextCalled = false;
  await debit({ headers: {} }, fakeRes(), () => { nextCalled = true; });
  assert.equal(evaluated, false);
  assert.equal(nextCalled, true);
});

test('dynamic cost that is <= 0, NaN, non-number or throws fails closed with 500', async () => {
  const bad = [() => 0, () => -5, () => NaN, () => Infinity, () => '3', async () => { throw new Error('boom'); }];
  for (const cost of bad) {
    const [, debit] = hybridAuth('svc', cost, { policy: 'credit-only' });
    const res = fakeRes();
    let nextCalled = false;
    await debit({ headers: {}, wallet: '0xabc' }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false, 'must not reach the route');
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.success, false);
  }
});
