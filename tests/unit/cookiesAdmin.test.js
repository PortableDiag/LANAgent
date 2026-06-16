import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseCookieFile } from '../../src/interfaces/web/cookiesAdmin.js';

const DAY = 24 * 3600;

// Build a Netscape-format cookie file with a known mix of cookies so the
// derived metrics are deterministic regardless of when the test runs.
function buildCookieFile() {
  const now = Math.floor(Date.now() / 1000);
  const rows = [
    // domain                flag   path  secure  expiration            name        value
    ['.example.com',        'TRUE', '/',  'FALSE', now - 10 * DAY,      'EXPIRED',  'a'], // expired
    ['.example.com',        'TRUE', '/',  'TRUE',  now + 10 * DAY,      'SOON',     'b'], // <=30d, secure
    ['.example.com',        'TRUE', '/',  'TRUE',  now + 200 * DAY,     'MEDIUM',   'c'], // <=365d, secure
    ['sub.other.com',       'FALSE','/',  'FALSE', now + 800 * DAY,     'LONG',     'd'], // >365d
  ];
  const lines = ['# Netscape HTTP Cookie File'];
  for (const r of rows) lines.push(r.join('\t'));
  return lines.join('\n') + '\n';
}

test('parseCookieFile derives expiration, secure, and domain metrics', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookies-analytics-'));
  const filePath = path.join(dir, 'example.com.txt');
  try {
    await fs.writeFile(filePath, buildCookieFile());
    const content = await fs.readFile(filePath, 'utf8');
    const analytics = parseCookieFile(content);

    // Comment line is ignored; 4 real cookies parsed.
    assert.equal(analytics.totalCookies, 4);

    // Expiration buckets.
    assert.deepEqual(analytics.expirations, {
      expired: 1,
      soon: 1,
      medium: 1,
      long: 1,
    });

    // Two cookies have the secure flag set.
    assert.equal(analytics.security.secureCookies, 2);
    assert.equal(analytics.security.securePercentage, 50);

    // No HttpOnly metric is fabricated (Netscape format has no such column).
    assert.equal(analytics.security.httpOnlyCookies, undefined);
    assert.equal(analytics.security.httpOnlyPercentage, undefined);

    // Two distinct domains.
    assert.equal(analytics.domainCount, 2);
    assert.ok(analytics.domains.includes('.example.com'));
    assert.ok(analytics.domains.includes('sub.other.com'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseCookieFile returns zeroed metrics for an empty file', () => {
  const analytics = parseCookieFile('# Netscape HTTP Cookie File\n');
  assert.equal(analytics.totalCookies, 0);
  assert.equal(analytics.security.securePercentage, 0);
  assert.equal(analytics.domainCount, 0);
  assert.deepEqual(analytics.domains, []);
});
