/**
 * A paid caller's scrape never reaches the agent's LAN (router-threat plan #401, D3, 2026-10-06):
 * the route refuses a private URL before taking credits, and the public-only client refuses a
 * host that resolves to a private address and a redirect to a private IP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assertPublicUrl, publicUrlErrorBody } from '../../src/utils/publicUrl.js';
import ScraperPlugin from '../../src/api/plugins/scraper.js';

test('LAN, loopback and metadata URLs are refused', async () => {
  for (const u of ['http://192.168.1.10/admin', 'http://127.0.0.1:3000/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/']) {
    await assert.rejects(() => assertPublicUrl(u), /private or local/, u);
  }
});

test('the public-only client refuses a private host and a redirect to a private IP; the normal one does not', async () => {
  const server = http.createServer((req, res) => res.end('lan page'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${server.address().port}/`;
  try {
    const s = new ScraperPlugin({});
    await assert.rejects(() => s.publicAxiosInstance.get(url), /private or local/);
    assert.equal((await s.axiosInstance.get(url)).data, 'lan page', 'the operator\'s own scrapes keep LAN access');
    assert.throws(() => s.publicAxiosInstance.defaults.beforeRedirect({ hostname: '192.168.0.1' }), /private or local/);
    assert.doesNotThrow(() => s.publicAxiosInstance.defaults.beforeRedirect({ hostname: '93.184.216.34' }));
  } finally {
    server.close();
  }
});

test('the browser guard aborts requests to private hosts, lets public ones through, and applies added block types', async () => {
  const handlers = [];
  const page = { setRequestInterception: async () => {}, on: (ev, fn) => { if (ev === 'request') handlers.push(fn); } };
  await new ScraperPlugin({})._guardPublicOnly(page);
  const fire = async (url, type = 'document') => {
    const out = {};
    const req = { url: () => url, resourceType: () => type,
      continue: async () => { out.did = 'continue'; }, abort: async (r) => { out.did = 'abort'; out.reason = r; } };
    await Promise.all(handlers.map(h => h(req)));
    return out;
  };
  assert.equal(handlers.length, 1, 'one handler: a second plain handler would race it');
  assert.deepEqual(await fire('http://192.168.0.1/admin'), { did: 'abort', reason: 'blockedbyclient' });
  assert.equal((await fire('http://169.254.169.254/latest/meta-data/')).did, 'abort');
  assert.equal((await fire('http://localhost:8080/')).did, 'abort');
  assert.equal((await fire('http://93.184.216.34/')).did, 'continue');
  assert.equal((await fire('data:image/png;base64,AAAA')).did, 'continue');
  page._publicOnly.blockTypes.add('script');
  assert.equal((await fire('http://93.184.216.34/app.js', 'script')).did, 'abort', 'the screenshot path blocks scripts through the guard');
});

test('a DNS outage during a VPN switch is waited out; NXDOMAIN fails at once; refusals are classified', async () => {
  const fail = (code) => Object.assign(new Error(code), { code });
  let calls = 0;
  const flaky = async () => { if (++calls < 3) throw fail('EAI_AGAIN'); return [{ address: '93.184.216.34' }]; };
  const sleep = async () => {};
  assert.equal(await assertPublicUrl('https://example.com/a', 'url', { lookup: flaky, sleep }), 'https://example.com/a');
  assert.equal(calls, 3, 'retried through the outage');

  calls = 0;
  const nx = async () => { calls++; throw fail('ENOTFOUND'); };
  await assert.rejects(() => assertPublicUrl('https://nope.invalid/', 'url', { lookup: nx, sleep }), (e) => e.errorKind === 'nxdomain' && e.httpStatus === 400);
  assert.equal(calls, 1, 'NXDOMAIN is not retried');

  const down = async () => { throw fail('EAI_AGAIN'); };
  const err = await assertPublicUrl('https://example.com/', 'url', { lookup: down, sleep, waitMs: 0 }).catch(e => e);
  assert.equal(err.errorKind, 'dns_temp');
  const body = publicUrlErrorBody(err);
  assert.equal(body.httpStatus, 503);
  assert.equal(body.retryable, true);
  assert.equal(body.targetError, false);

  const priv = publicUrlErrorBody(await assertPublicUrl('http://192.168.0.1/').catch(e => e));
  assert.deepEqual([priv.httpStatus, priv.errorKind, priv.targetError], [400, 'private_address', true]);
});
