import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import YtDlpPlugin from '../../src/api/plugins/ytdlp.js';

test('a DNS failure during a VPN exit switch is a network error (real stderr, 2026-10-15)', () => {
  const line = "ERROR: [youtube] OJXjFcDDsv4: Unable to download API page: HTTPSConnection(host='www.youtube.com', port=443): Failed to resolve 'www.youtube.com' ([Errno -3] Temporary failure in name resolution)";
  assert.equal(YtDlpPlugin.isNetworkError(line), true);
  assert.equal(YtDlpPlugin.isNetworkError('[Errno 101] Network is unreachable'), true);
  assert.equal(YtDlpPlugin.isNetworkError('ERROR: unable to download video data: HTTP Error 403: Forbidden'), false, 'a refusal is not an outage');
  assert.equal(YtDlpPlugin.isNetworkError('Requested format is not available'), false);
});

test('waitForHost returns once the host resolves, false when it never does', async () => {
  let calls = 0;
  const flaky = async () => { if (++calls < 3) throw new Error('EAI_AGAIN'); return { address: '1.2.3.4' }; };
  assert.equal(await YtDlpPlugin.waitForHost('https://www.youtube.com/watch?v=x', { intervalMs: 1, lookup: flaky }), true);
  assert.equal(calls, 3);
  const dead = async () => { throw new Error('EAI_AGAIN'); };
  assert.equal(await YtDlpPlugin.waitForHost('https://www.youtube.com/', { maxMs: 20, intervalMs: 5, lookup: dead }), false);
  assert.equal(await YtDlpPlugin.waitForHost('not a url', { lookup: dead }), false);
});

test('a network failure re-runs the same command, bounded; other failures throw at once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytdlp-net-'));
  const runs = path.join(dir, 'runs');
  const p = Object.create(YtDlpPlugin.prototype);
  try {
    await assert.rejects(p._execRidingOutages(`echo r >> "${runs}"; echo "Failed to resolve x" >&2; exit 1`, 'http://localhost/v'));
    assert.equal((await fs.readFile(runs, 'utf8')).trim().split('\n').length, 1 + YtDlpPlugin.NETWORK_WAITS);

    await fs.rm(runs);
    await assert.rejects(p._execRidingOutages(`echo r >> "${runs}"; echo "HTTP Error 403" >&2; exit 1`, 'http://localhost/v'));
    assert.equal((await fs.readFile(runs, 'utf8')).trim().split('\n').length, 1, 'no retry for a refusal');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
