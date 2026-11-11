import assert from 'node:assert/strict';
import test from 'node:test';
import PriceWatchPlugin from '../../src/api/plugins/priceWatch.js';

function plugin() {
  return new PriceWatchPlugin({});
}

test('compare accepts multiple retailer entries and reports each unreadable URL independently', async () => {
  const result = await plugin().compare({
    urls: [
      'not-a-url',
      { url: undefined, name: 'Second retailer', selector: '.price' },
      { url: 'also-not-a-url', name: 'Third retailer' }
    ]
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.results, []);
  assert.equal(result.failures.length, 3);
  assert.equal(result.failures[0].url, 'not-a-url');
  assert.equal(result.failures[1].name, 'Second retailer');
  assert.equal(result.failures[2].name, 'Third retailer');
  assert.match(result.result, /Unable to read:/);
  assert.match(result.result, /Second retailer/);
});

test('compare rejects an empty retailer list', async () => {
  await assert.rejects(
    () => plugin().compare({ urls: [] }),
    { message: 'at least one retailer url is required' }
  );
});

test('compare limits one-shot comparisons to ten retailer URLs', async () => {
  await assert.rejects(
    () => plugin().compare({
      urls: Array.from({ length: 11 }, (_, i) => `invalid-${i}`)
    }),
    { message: 'a maximum of 10 retailer urls can be compared at once' }
  );
});

test('compare requires urls to be an array', async () => {
  await assert.rejects(
    () => plugin().compare({ urls: 'https://shop.example/item' }),
    { message: 'urls must be an array' }
  );
});

// A successful read, without network: the URL check and the price reader are stubbed.
function stubbed(readings) {
  const p = plugin();
  p._assertPublicUrl = async (url) => url;
  p._readPrice = async (url) => {
    const r = readings[url];
    if (r instanceof Error) throw r;
    return r;
  };
  return p;
}

test('compare ranks by price within one currency and keeps the low-confidence warning', async () => {
  const result = await stubbed({
    'https://a.example/x': { price: 19.99, currency: 'USD', title: 'A' },
    'https://b.example/x': { price: 14.5, currency: 'USD', title: 'B', confidence: 'low' },
    'https://c.example/x': new Error('could not read a price (no price in the page)')
  }).compare({ urls: ['https://a.example/x', 'https://b.example/x', 'https://c.example/x'] });

  assert.equal(result.success, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.failures.length, 1);
  const lines = result.result.split('\n');
  assert.match(lines[0], /^1\. B: USD 14\.5 \(read from the page text.*confirm it\)/);
  assert.match(lines[1], /^2\. A: USD 19\.99/);
  assert.equal(result.results.find(r => r.title === 'B').confidence, 'low');
  assert.match(result.result, /Unable to read:/);
});

test('compare never ranks prices in different currencies against each other', async () => {
  const result = await stubbed({
    'https://us.example/x': { price: 10, currency: 'USD', title: 'US' },
    'https://eu.example/x': { price: 9, currency: 'EUR', title: 'EU' },
    'https://us2.example/x': { price: 8, currency: 'USD', title: 'US2' }
  }).compare({ urls: ['https://us.example/x', 'https://eu.example/x', 'https://us2.example/x'] });

  assert.match(result.result, /different currencies/);
  // USD group ranked on its own (US2 8 before US 10); EUR listed separately as its own #1
  assert.match(result.result, /USD\n1\. US2: USD 8.*\n2\. US: USD 10/);
  assert.match(result.result, /EUR\n1\. EU: EUR 9/);
});

// pause / resume: stub the WebWatch lookup that findWatch uses, no live mongo.
import WebWatch from '../../src/models/WebWatch.js';
import { getWebWatchService } from '../../src/services/webtools/webWatchService.js';

function fakeWatch(fields = {}) {
  return { _id: 'w1', kind: 'price', name: 'Monitor', url: 'https://shop.example/item', active: true,
    intervalMin: 120, saved: 0, async save() { this.saved++; return this; }, ...fields };
}

async function withWatch(w, fn) {
  const orig = WebWatch.findOne;
  WebWatch.findOne = async () => w;
  try { return await fn(); } finally { WebWatch.findOne = orig; }
}

test('pause clears active and keeps the interval, so checkDue skips it', async () => {
  const w = fakeWatch();
  const r = await withWatch(w, () => plugin().execute({ action: 'pause', url: w.url }));
  assert.equal(r.success, true);
  assert.equal(w.active, false);
  assert.equal(w.intervalMin, 120);
  assert.equal(w.saved, 1);
  assert.match(r.result, /Paused Monitor/);

  const origFind = WebWatch.find;
  let filter;
  WebWatch.find = (f) => { filter = f; return { lean: async () => [] }; };
  try { await getWebWatchService({}).checkDue(new Date(), { kind: 'price' }); } finally { WebWatch.find = origFind; }
  assert.equal(filter.active, true);
});

test('pause on an already-paused watch does not write', async () => {
  const w = fakeWatch({ active: false });
  const r = await withWatch(w, () => plugin().execute({ action: 'pause', url: w.url }));
  assert.equal(r.success, true);
  assert.equal(w.saved, 0);
  assert.match(r.result, /already paused/);
});

test('resume sets active and keeps the interval unless one is given', async () => {
  const w = fakeWatch({ active: false });
  let r = await withWatch(w, () => plugin().execute({ action: 'resume', url: w.url }));
  assert.equal(r.success, true);
  assert.equal(w.active, true);
  assert.equal(w.intervalMin, 120);

  w.active = false;
  r = await withWatch(w, () => plugin().execute({ action: 'resume', url: w.url, interval: 5 }));
  assert.equal(w.intervalMin, 15); // clamped to the model minimum
  assert.match(r.result, /every 15 min/);
});
