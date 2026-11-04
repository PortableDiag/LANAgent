import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import youtubeRouter, { summarizeFormats, estimateMp4Bytes } from '../../src/api/external/routes/youtube.js';

// Minimal Express-style res stub that captures status + json payload.
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test('GET /quota reports credit-based quota from req.creditBalance', async () => {
  // Locate the /quota route and its final handler (creditAuth is the first
  // layer; the handler is the last). We call the handler directly so the test
  // needs no auth/DB and no external deps.
  const routeLayer = youtubeRouter.stack.find(layer => layer.route?.path === '/quota');
  assert.ok(routeLayer, 'Quota route should exist');
  const handler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

  const req = { creditBalance: 100 }; // what creditAuth actually sets
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.quota.creditsRemaining, 100);
  // mp4 costs 10 → 10 downloads; mp3 costs 8 → 12 downloads
  assert.equal(res.body.quota.formatLimits.mp4.cost, 10);
  assert.equal(res.body.quota.formatLimits.mp4.remaining, 10);
  assert.equal(res.body.quota.formatLimits.mp3.cost, 8);
  assert.equal(res.body.quota.formatLimits.mp3.remaining, 12);
});

// --- POST /info. The stub returns what ytdlp.getVideoInfo really returns: `data` + `raw`. ---

const infoLayers = () => youtubeRouter.stack.find(l => l.route?.path === '/info').route.stack.map(l => l.handle);
const REAL_FORMATS = [
  { format_id: 'sb3', ext: 'mhtml', resolution: '48x27', vcodec: 'none', acodec: 'none', format_note: 'storyboard', url: 'https://signed/sb' },
  { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 3000000, url: 'https://signed/a' },
  { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a', filesize: 9000000, url: 'https://signed/18' },
  { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'none', filesize_approx: 50000000, url: 'https://signed/137' }
];
const realInfo = {
  success: true,
  data: { title: 'T', duration: '3:33', uploadDate: '2009-10-25', formats: 4 },
  raw: { title: 'T', channel: 'C', duration: 213, thumbnail: 'th.jpg', webpage_url: 'https://www.youtube.com/watch?v=x', formats: REAL_FORMATS }
};

test('POST /info answers from the shape getVideoInfo really returns', async () => {
  const handler = infoLayers().at(-1);
  const apis = new Map([['ytdlp', { instance: { execute: async () => realInfo }, enabled: true }]]);
  const res = makeRes();
  await handler({ body: { url: 'https://www.youtube.com/watch?v=x' }, app: { locals: { agent: { apiManager: { apis } } } } }, res);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.title, 'T');
  assert.equal(res.body.data.durationSeconds, 213);
  assert.equal(res.body.data.formats.length, 3, 'storyboard dropped');
  assert.equal(res.body.data.estimatedMp4Bytes, 53000000);
  assert.ok(!JSON.stringify(res.body).includes('signed'), 'signed media URLs never leave');
});

test('POST /info refuses a bad URL before the debit, so it costs nothing', () => {
  const layers = infoLayers();
  const guard = layers[1];
  for (const [body, msg] of [[{}, /Missing url/], [{ url: 'https://example.com/x' }, /Invalid YouTube/], [{ url: ['x'] }, /Missing url/]]) {
    const res = makeRes();
    let passed = false;
    guard({ body }, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, msg);
  }
  let passed = false;
  guard({ body: { url: 'https://youtu.be/x' } }, makeRes(), () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(layers.length, 4, 'auth, url check, debit, handler in that order');
});

test('POST /info failures carry targetError, which is what refunds the credit', async () => {
  const handler = infoLayers().at(-1);
  const call = async (execute) => {
    const apis = new Map([['ytdlp', { instance: { execute }, enabled: true }]]);
    const res = makeRes();
    await handler({ body: { url: 'https://youtu.be/x' }, app: { locals: { agent: { apiManager: { apis } } } } }, res);
    return res;
  };
  const failed = await call(async () => ({ success: false, error: 'Video unavailable' }));
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.targetError, true);
  const threw = await call(async () => { throw new Error('boom'); });
  assert.equal(threw.statusCode, 500);
  assert.equal(threw.body.targetError, true);
});

test('estimateMp4Bytes is null when a size is unknown, never a guess', () => {
  assert.equal(estimateMp4Bytes([{ format_id: '1', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'none' }]), null);
  assert.equal(estimateMp4Bytes(undefined), null);
  assert.deepEqual(summarizeFormats(null), []);
});
