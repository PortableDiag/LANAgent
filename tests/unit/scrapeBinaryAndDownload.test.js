/**
 * Non-page URLs (2026-11-02).
 * - A binary file (GSS_stata.zip) was decoded as UTF-8 and parsed as HTML; cheerio
 *   overflowed the stack, and the paid route ran five tiers over 19 s before failing.
 * - A file Chrome downloads (federalregister .txt) leaves FlareSolverr on Chrome's New
 *   Tab page, which was logged as "redirected off the public internet".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const NEW_TAB = '<html><head><title>New Tab</title></head><body>New Tab</body></html>';
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4000, 0x41)]);
const GZ = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.alloc(100, 0x42)]);
const TXT = 'Federal Register notice. '.repeat(40);

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const { url } = JSON.parse(body);
      const finalUrl = url.includes('neterr') ? 'chrome-error://chromewebdata/' : 'chrome://new-tab-page/';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', solution: { url: finalUrl, status: 200, headers: {}, response: NEW_TAB, cookies: [], userAgent: 'x' } }));
    });
    return;
  }
  if (req.url.endsWith('.zip')) { res.setHeader('Content-Type', 'application/zip'); return res.end(ZIP); }
  if (req.url.endsWith('.gz')) { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(GZ); }
  res.setHeader('Content-Type', 'text/plain');
  res.end(TXT);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.FLARESOLVERR_URL = `${base}/v1`;

const { default: ScraperPlugin, isBinaryBody } = await import('../../src/api/plugins/scraper.js');

test.after(() => server.close());

test('isBinaryBody: binary formats yes, text and HTML no', () => {
  assert.equal(isBinaryBody(ZIP), true);
  assert.equal(isBinaryBody(GZ), true);
  assert.equal(isBinaryBody(Buffer.from([0x41, 0x00, 0x42])), true);
  assert.equal(isBinaryBody(Buffer.from('<html><body>héllo</body></html>')), false);
  assert.equal(isBinaryBody(Buffer.from(TXT)), false);
  assert.equal(isBinaryBody(Buffer.alloc(0)), false);
});

test('isBinaryBody: a text file with a few stray NULs is text, random bytes are not', () => {
  const doc = Buffer.from('<html><body><pre>' + 'Federal Register text line.\n'.repeat(250) + '</pre></body></html>');
  for (const i of [687, 689, 691, 740, 742, 900, 902, 904, 1500, 1502, 1504, 1506]) doc[i] = 0;
  assert.equal(isBinaryBody(doc), false);
  let x = 12345;
  const noise = Buffer.alloc(4096, 0).map(() => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x >> 16 & 0xff; });
  noise[0] = 0x41; noise[100] = 0;
  assert.equal(isBinaryBody(noise), true);
});

test('a zip on the direct path fails clearly, without a stack overflow', async () => {
  await assert.rejects(new ScraperPlugin({}).scrapeWithCheerio(`${base}/data/GSS_stata.zip`, { bypassCache: true }),
    /Unsupported content: application\/zip file \(4004 bytes\)/);
});

test('gzip served as octet-stream is caught by its magic number', async () => {
  await assert.rejects(new ScraperPlugin({}).scrapeWithCheerio(`${base}/a.gz`, { bypassCache: true }), /Unsupported content/);
});

test('a file FlareSolverr downloads is fetched directly, not reported as a redirect', async () => {
  const r = await new ScraperPlugin({}).scrapeWithFlareSolverr(`${base}/doc/2019-06199.txt`, {});
  assert.equal(r.success, true);
  assert.match(r.content.text, /Federal Register notice/);
});

test('chrome-error:// still fails as a net error', async () => {
  await assert.rejects(new ScraperPlugin({}).scrapeWithFlareSolverr(`${base}/neterr.html`, { publicOnly: true }),
    /net::ERR_FAILED .*could not reach site/);
});
