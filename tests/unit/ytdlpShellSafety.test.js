/**
 * Input boundary for the yt-dlp plugin.
 *
 * Every command in this plugin is built by string interpolation and run through a
 * shell (`promisify(exec)`). Double quotes do not stop command substitution, and
 * `-f ${format}` is not quoted at all. The values arrive from customer-facing routes
 * (external/routes/social.js /probe, /download, /preview), and the host check upstream
 * only requires the string to parse as a URL — so
 *
 *     https://youtube.com/watch?v=a"$(id)"
 *
 * passes `new URL()`, reports hostname youtube.com, and reaches the shell intact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import YtDlpPlugin from '../../src/api/plugins/ytdlp.js';

const plugin = () => {
  const p = new YtDlpPlugin({ logger: { info() {}, warn() {}, error() {} } });
  // Any action reaching a handler would shell out; the guard must refuse first.
  p.downloadMedia = async () => ({ success: true, reached: true });
  p.getVideoInfo = async () => ({ success: true, reached: true });
  p.listFormats = async () => ({ success: true, reached: true });
  p.searchVideos = async () => ({ success: true, reached: true });
  return p;
};

const INJECTIONS = [
  'https://youtube.com/watch?v=a"$(id)"',
  'https://youtube.com/watch?v=a`id`',
  'https://youtube.com/watch?v=a;id',
  'https://youtube.com/watch?v=a|id',
  'https://youtube.com/watch?v=a&&id',
  'https://youtube.com/watch?v=a>out',
  "https://youtube.com/watch?v=a'id'",
  'https://youtube.com/watch?v=a\nid'
];

for (const url of INJECTIONS) {
  test(`a url carrying shell metacharacters is refused: ${JSON.stringify(url.slice(28))}`, async () => {
    const result = await plugin().execute({ action: 'formats', url });
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid url/);
    assert.ok(!result.reached, 'the handler must not be reached');
  });
}

test('a query separator is not an injection, and is the only "&" allowed', async () => {
  for (const url of ['https://youtube.com/watch?v=a&t=30s', 'https://youtube.com/watch?v=a&list=PLx&index=2']) {
    assert.equal(plugin()._rejectShellUnsafe({ url }), null, url);
  }
  for (const url of ['https://youtube.com/watch?v=a&id', 'https://youtube.com/watch?v=a&b=$(id)', 'https://youtube.com/watch?v=a&&b=1']) {
    assert.match(plugin()._rejectShellUnsafe({ url }) || '', /Invalid url/, url);
  }
  assert.match(plugin()._rejectShellUnsafe({ format: 'mp4&a=1' }) || '', /Invalid format/);
});

test('the injection payload really does pass every upstream check', () => {
  // This is why the guard has to live here rather than in the route: the URL is valid.
  const url = 'https://youtube.com/watch?v=a"$(id)"';
  assert.equal(new URL(url).hostname, 'youtube.com');
});

test('format and quality are guarded too, not just url', async () => {
  // `-f ${format}` is interpolated WITHOUT quotes, so it is the softest target.
  const bad = await plugin().execute({
    action: 'download', url: 'https://youtube.com/watch?v=x', format: 'mp4; id'
  });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Invalid format/);

  const badQuality = await plugin().execute({
    action: 'download', url: 'https://youtube.com/watch?v=x', quality: '1080p`id`'
  });
  assert.equal(badQuality.success, false);
  assert.match(badQuality.error, /Invalid quality/);
});

test('a search query is guarded', async () => {
  const r = await plugin().execute({ action: 'search', query: 'cats; id' });
  assert.equal(r.success, false);
  assert.match(r.error, /Invalid query/);
});

test('ordinary values still pass through untouched', async () => {
  for (const params of [
    { action: 'formats', url: 'https://youtube.com/watch?v=dQw4w9WgXcQ' },
    { action: 'download', url: 'https://youtube.com/watch?v=x', format: 'mp4', quality: '1080p' },
    { action: 'search', query: 'lo-fi beats' },
    // Percent-encoded characters are how a legitimate URL carries these.
    { action: 'info', url: 'https://example.com/v?t=a%22b%24c' }
  ]) {
    const r = await plugin().execute(params);
    assert.equal(r.success, true, `${JSON.stringify(params)} must not be refused`);
    assert.equal(r.reached, true, 'the handler must still be reached');
  }
});

test('a non-string value is not mistaken for an injection', async () => {
  const r = await plugin().execute({ action: 'formats', url: 'https://youtube.com/x', quality: 1080 });
  assert.equal(r.success, true);
});
