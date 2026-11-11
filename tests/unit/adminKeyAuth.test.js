/**
 * adminKeyAuth guards the whole admin router (`router.use(adminKeyAuth)`) plus
 * /block-stats. Its documented contract is FAIL CLOSED, so these cases pin the
 * behaviour that matters: a misconfigured window must deny, never fall open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import adminKeyAuth, { parseTimeWindows, isWithinTimeWindows } from '../../src/api/external/middleware/adminKeyAuth.js';

const KEY = 'test-admin-key';

function run(headers = {}, env = {}, ip = '10.0.0.1') {
  const prev = {
    AGENT_ADMIN_KEY: process.env.AGENT_ADMIN_KEY,
    AGENT_ADMIN_KEY_WINDOWS: process.env.AGENT_ADMIN_KEY_WINDOWS,
    AGENT_ADMIN_KEY_ALLOWED_IPS: process.env.AGENT_ADMIN_KEY_ALLOWED_IPS,
    AGENT_ADMIN_KEY_BLOCKED_IPS: process.env.AGENT_ADMIN_KEY_BLOCKED_IPS
  };
  Object.assign(process.env, env);
  for (const k of Object.keys(prev)) {
    if (!(k in env)) delete process.env[k];
  }
  const res = {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  let nexted = false;
  adminKeyAuth({ headers, ip, get: () => 'test' }, res, () => { nexted = true; });
  Object.assign(process.env, prev);
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
  return { nexted, status: res.statusCode, body: res.body };
}

test('503 when no admin key is configured', () => {
  assert.equal(run({ 'x-admin-key': 'anything' }, {}).status, 503);
});

test('401 on a missing or wrong key', () => {
  assert.equal(run({}, { AGENT_ADMIN_KEY: KEY }).status, 401);
  assert.equal(run({ 'x-admin-key': 'wrong' }, { AGENT_ADMIN_KEY: KEY }).status, 401);
});

test('passes with the right key and no window restriction', () => {
  assert.equal(run({ 'x-admin-key': KEY }, { AGENT_ADMIN_KEY: KEY }).nexted, true);
});

test('a malformed window string DENIES — it must not read as "unrestricted"', () => {
  // The original returned [] on a parse failure, which isWithinTimeWindows()
  // treats as "no restriction", silently disabling the control.
  for (const bad of ['garbage', '09:00_17:00', '09:00-', '25:00-26:00', '09:60-10:00', '9-17']) {
    const r = run({ 'x-admin-key': KEY }, { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_WINDOWS: bad });
    assert.equal(r.nexted, false, `"${bad}" fell open`);
    assert.equal(r.status, 503, `"${bad}" should be 503`);
  }
});

test('an empty or whitespace window string means unrestricted, not misconfigured', () => {
  for (const empty of ['', '   ']) {
    assert.equal(run({ 'x-admin-key': KEY }, { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_WINDOWS: empty }).nexted, true);
  }
});

test('a valid window allows now and denies outside it', () => {
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const at = m => `${pad(Math.floor(((m % 1440) + 1440) % 1440 / 60))}:${pad(((m % 60) + 60) % 60)}`;

  const inside = `${at(cur - 60)}-${at(cur + 60)}`;
  const outside = `${at(cur + 120)}-${at(cur + 180)}`;

  // Skip the wrap-around edge where a synthetic window would cross midnight.
  if (cur > 180 && cur < 1440 - 180) {
    assert.equal(run({ 'x-admin-key': KEY }, { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_WINDOWS: inside }).nexted, true);
    const r = run({ 'x-admin-key': KEY }, { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_WINDOWS: outside });
    assert.equal(r.nexted, false);
    assert.equal(r.status, 403);
  }
});

test('the key check runs before the window check', () => {
  // A wrong key outside the window must still report 401, not 403 — the window
  // must never become an oracle for key validity.
  const r = run({ 'x-admin-key': 'wrong' }, { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_WINDOWS: '00:00-00:01' });
  assert.equal(r.status, 401);
});

test('parseTimeWindows converts to minutes and throws on bad input', () => {
  assert.deepEqual(parseTimeWindows('09:00-17:00'), [{ start: 540, end: 1020 }]);
  assert.deepEqual(parseTimeWindows('09:00-12:00,13:00-17:00'), [{ start: 540, end: 720 }, { start: 780, end: 1020 }]);
  assert.deepEqual(parseTimeWindows(''), []);
  assert.deepEqual(parseTimeWindows(undefined), []);
  assert.throws(() => parseTimeWindows('nope'), /invalid window/);
  assert.throws(() => parseTimeWindows('24:00-25:00'), /invalid time/);
});

test('overnight windows wrap past midnight', () => {
  const overnight = [{ start: 22 * 60, end: 6 * 60 }];
  assert.equal(isWithinTimeWindows(overnight), (() => {
    const c = new Date().getHours() * 60 + new Date().getMinutes();
    return c >= 22 * 60 || c <= 6 * 60;
  })());
  assert.equal(isWithinTimeWindows([]), true);
});

// ---------------------------------------------------------------------------
// IP allow/block list tests
// ---------------------------------------------------------------------------

test('blocked IP denies access with 403', () => {
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_BLOCKED_IPS: '10.0.0.1' },
    '10.0.0.1'
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('allowed IP permits access when client IP is in list', () => {
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: '10.0.0.1' },
    '10.0.0.1'
  );
  assert.equal(r.nexted, true);
});

test('allowed IP denies access when client IP is not in list', () => {
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: '10.0.0.2' },
    '10.0.0.1'
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('blocked IP takes precedence over allowed IP', () => {
  const r = run(
    { 'x-admin-key': KEY },
    {
      AGENT_ADMIN_KEY: KEY,
      AGENT_ADMIN_KEY_BLOCKED_IPS: '10.0.0.1',
      AGENT_ADMIN_KEY_ALLOWED_IPS: '10.0.0.1'
    },
    '10.0.0.1'
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('malformed blocked IP list denies with 503 (fail-closed)', () => {
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_BLOCKED_IPS: 'not-an-ip' },
    '10.0.0.1'
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 503);
});

test('malformed allowed IP list denies with 503 (fail-closed)', () => {
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: 'not-an-ip' },
    '10.0.0.1'
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 503);
});

test('empty or whitespace IP lists mean no restriction', () => {
  for (const empty of ['', '   ']) {
    const r = run(
      { 'x-admin-key': KEY },
      { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: empty },
      '10.0.0.1'
    );
    assert.equal(r.nexted, true, `allowed IPs "${empty}" should be unrestricted`);
    const r2 = run(
      { 'x-admin-key': KEY },
      { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_BLOCKED_IPS: empty },
      '10.0.0.1'
    );
    assert.equal(r2.nexted, true, `blocked IPs "${empty}" should be unrestricted`);
  }
});

test('IPv4-mapped IPv6 client address is normalized and matched', () => {
  // ::ffff:10.0.0.1 should be treated as 10.0.0.1
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: '10.0.0.1' },
    '::ffff:10.0.0.1'
  );
  assert.equal(r.nexted, true);
});

test('CIDR range in allowed IPs matches correctly', () => {
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: '10.0.0.0/24' },
    '10.0.0.42'
  );
  assert.equal(r.nexted, true);
});

test('CIDR range in blocked IPs matches correctly', () => {
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_BLOCKED_IPS: '10.0.0.0/24' },
    '10.0.0.42'
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('CIDR range does not match IP outside range', () => {
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: '10.0.0.0/24' },
    '10.0.1.1'
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('key check runs before IP checks', () => {
  // Wrong key with blocked IP should still return 401, not 403
  const r = run(
    { 'x-admin-key': 'wrong' },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_BLOCKED_IPS: '10.0.0.1' },
    '10.0.0.1'
  );
  assert.equal(r.status, 401);
});

test('IPv6 exact match works in allow list', () => {
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: '2001:db8::1' },
    '2001:db8::1'
  );
  assert.equal(r.nexted, true);
});

test('IPv6 exact match works in block list', () => {
  const r = run(
    { 'x-admin-key': KEY },
    { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_BLOCKED_IPS: '2001:db8::1' },
    '2001:db8::1'
  );
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('IPv6 CIDR matches inside the range and denies outside it', () => {
  const env = { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: '2001:db8::/32' };
  assert.equal(run({ 'x-admin-key': KEY }, env, '2001:db8:1::5').nexted, true);
  const out = run({ 'x-admin-key': KEY }, env, '2001:db9::1');
  assert.equal(out.nexted, false);
  assert.equal(out.status, 403);
});

test('a non-canonical IPv6 block entry still blocks the canonical client address', () => {
  const r = run({ 'x-admin-key': KEY }, { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_BLOCKED_IPS: '2001:0db8:0000::0001' }, '2001:db8::1');
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('a bad CIDR prefix fails closed', () => {
  for (const bad of ['10.0.0.0/33', '10.0.0.0/', '10.0.0.0/abc', '2001:db8::/129']) {
    const r = run({ 'x-admin-key': KEY }, { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: bad }, '10.0.0.1');
    assert.equal(r.status, 503, bad);
  }
});

test('an allow list denies a request with no usable client IP', () => {
  const r = run({ 'x-admin-key': KEY }, { AGENT_ADMIN_KEY: KEY, AGENT_ADMIN_KEY_ALLOWED_IPS: '10.0.0.1' }, null);
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// Multiple admin keys (comma-separated AGENT_ADMIN_KEY)
// ---------------------------------------------------------------------------

test('multiple keys: any valid key passes', () => {
  const keys = 'key1,key2,key3';
  assert.equal(run({ 'x-admin-key': 'key1' }, { AGENT_ADMIN_KEY: keys }).nexted, true);
  assert.equal(run({ 'x-admin-key': 'key2' }, { AGENT_ADMIN_KEY: keys }).nexted, true);
  assert.equal(run({ 'x-admin-key': 'key3' }, { AGENT_ADMIN_KEY: keys }).nexted, true);
});

test('multiple keys: wrong key fails with 401', () => {
  const keys = 'key1,key2';
  const r = run({ 'x-admin-key': 'wrong' }, { AGENT_ADMIN_KEY: keys });
  assert.equal(r.nexted, false);
  assert.equal(r.status, 401);
});

test('multiple keys: whitespace around keys is trimmed', () => {
  const keys = ' key1 ,  key2 , key3 ';
  assert.equal(run({ 'x-admin-key': 'key1' }, { AGENT_ADMIN_KEY: keys }).nexted, true);
  assert.equal(run({ 'x-admin-key': 'key2' }, { AGENT_ADMIN_KEY: keys }).nexted, true);
  assert.equal(run({ 'x-admin-key': 'key3' }, { AGENT_ADMIN_KEY: keys }).nexted, true);
});

test('multiple keys: trailing comma is ignored', () => {
  const keys = 'key1,key2,';
  assert.equal(run({ 'x-admin-key': 'key1' }, { AGENT_ADMIN_KEY: keys }).nexted, true);
  assert.equal(run({ 'x-admin-key': 'key2' }, { AGENT_ADMIN_KEY: keys }).nexted, true);
  // empty entry after trailing comma is discarded, so empty string is not a valid key
  const r = run({ 'x-admin-key': '' }, { AGENT_ADMIN_KEY: keys });
  assert.equal(r.status, 401);
});

test('multiple keys: empty entries are ignored', () => {
  const keys = 'key1,,key2';
  assert.equal(run({ 'x-admin-key': 'key1' }, { AGENT_ADMIN_KEY: keys }).nexted, true);
  assert.equal(run({ 'x-admin-key': 'key2' }, { AGENT_ADMIN_KEY: keys }).nexted, true);
  // empty string between commas is not a valid key
  const r = run({ 'x-admin-key': '' }, { AGENT_ADMIN_KEY: keys });
  assert.equal(r.status, 401);
});

test('multiple keys: all keys empty after trimming returns 503', () => {
  const keys = ' ,  , ';
  const r = run({ 'x-admin-key': 'anything' }, { AGENT_ADMIN_KEY: keys });
  assert.equal(r.nexted, false);
  assert.equal(r.status, 503);
});

test('multiple keys: single key still works (backward compatibility)', () => {
  assert.equal(run({ 'x-admin-key': KEY }, { AGENT_ADMIN_KEY: KEY }).nexted, true);
});

test('multiple keys: a key list is not a substring or prefix match', () => {
  const keys = 'key1,key2';
  assert.equal(run({ 'x-admin-key': 'key' }, { AGENT_ADMIN_KEY: keys }).status, 401);
  assert.equal(run({ 'x-admin-key': 'key1,key2' }, { AGENT_ADMIN_KEY: keys }).status, 401);
  assert.equal(run({ 'x-admin-key': 'key12' }, { AGENT_ADMIN_KEY: keys }).status, 401);
});

test('multiple keys: IP lists still apply to a valid second key', () => {
  const r = run({ 'x-admin-key': 'key2' }, { AGENT_ADMIN_KEY: 'key1,key2', AGENT_ADMIN_KEY_BLOCKED_IPS: '203.0.113.9' }, '203.0.113.9');
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});
