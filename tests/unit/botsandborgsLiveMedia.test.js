// Store 0.56: a live avatar's pictures (GET /api/live/<slug>/media) kept in a library item of their own, fetched only
// when a file's sha256 is new, dropped when no longer listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';
import { encrypt } from '../../src/utils/encryption.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('live pictures: kept per pass, fetched once by sha256, dropped when the store stops listing them', async () => {
  const store = { library: { items: [{ variant: 'vrm-racer-blue-bundle', title: 'Racer Blue — VRM Avatar', files: [{ name: 'racer.vrm', kind: 'vrm' }] }] } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const p = new BotsAndBorgsPlugin({ agentModel: {} });
  p.libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livemedia-'));
  const happy = Buffer.from('happy-png'), portrait = Buffer.from('portrait-png');
  // Two folders with the same file name stay two files.
  let listing = [{ name: 'Emoji/cool.png', kind: 'emoji', sha256: sha(Buffer.from('e')), url: '/m/emoji-cool' }, { name: 'Racer Blue cool.png', kind: 'sticker', sha256: sha(happy), url: '/m/happy' }, { name: 'portrait-1024.png', kind: 'portrait', sha256: sha(portrait), url: '/m/portrait' }];
  const gets = [];
  p.fetchLive = async (url, headers) => {
    if (/\/media$/.test(url)) return { status: 200, data: Buffer.from(JSON.stringify({ files: listing })) };
    gets.push(url);
    return { status: 200, data: /happy/.test(url) ? happy : portrait, headers: { 'content-type': 'image/png' } };
  };
  const pass = { slug: 'vrm-racer-blue-live30', key: encrypt('bnbl_x'), state: 'active' };
  await p.syncLiveMedia([pass]);
  const item = store.library.items.find(i => i.variant === 'live-media-vrm-racer-blue');
  assert.ok(item, 'its own library item');
  assert.ok(!item.files.some(f => /[\\/]/.test(f.name)), 'no path in a stored name');
  assert.equal(item.title, 'Racer Blue (live pictures)');
  assert.deepEqual(item.files.map(f => f.kind).sort(), ['emoji', 'portrait', 'sticker']);
  assert.equal(item.files.find(f => f.kind === 'sticker').mood, 'cool');
  assert.equal(gets.length, 3);
  // Unchanged: nothing fetched.
  await p.syncLiveMedia([pass]);
  assert.equal(gets.length, 3);
  // The store drops the portrait: its file and entry go.
  listing = listing.slice(0, 2);
  await p.syncLiveMedia([pass]);
  const after = store.library.items.find(i => i.variant === 'live-media-vrm-racer-blue');
  assert.deepEqual(after.files.map(f => f.name), ['Emoji__cool.png', 'Racer Blue cool.png']);
  assert.equal(fs.existsSync(path.join(p.libraryRoot, 'live-media-vrm-racer-blue', 'portrait-1024.png')), false);
});
