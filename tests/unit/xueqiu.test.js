/**
 * Multi-symbol comparison.
 *
 * The PR shipped no test. The property worth pinning is that a symbol which fails to
 * fetch is reported rather than dropped: a comparison returning two rows for three
 * requested symbols reads as "that one has no data" when the truth is "that request
 * failed", and the caller cannot tell those apart from the result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import XueqiuPlugin from '../../src/api/plugins/xueqiu.js';

const quoteFor = (symbol) => ({
  symbol, name: `Name ${symbol}`, price: 100, change: 1, percent: 1,
  open: 99, high: 101, low: 98, lastClose: 99, volume: 1234,
  turnoverRate: 0.5, market: 'US', time: 1
});

const plugin = ({ failing = [] } = {}) => {
  const p = new XueqiuPlugin({ logger: { info() {}, warn() {}, error() {} } });
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  p.getStockQuote = async (symbol) => {
    if (failing.includes(symbol)) throw new Error('upstream 500');
    return quoteFor(symbol);
  };
  return p;
};

test('every requested symbol comes back as a normalised row', async () => {
  const result = await plugin().compareStocks(['TSLA', 'AAPL']);
  assert.equal(result.requested, 2);
  assert.equal(result.quotes.length, 2);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(Object.keys(result.quotes[0]).sort(), [
    'change', 'high', 'lastClose', 'low', 'market', 'name', 'open',
    'percent', 'price', 'symbol', 'time', 'turnoverRate', 'volume'
  ]);
});

test('a symbol that fails is reported, not silently dropped', async () => {
  const result = await plugin({ failing: ['AAPL'] }).compareStocks(['TSLA', 'AAPL', 'MSFT']);
  assert.equal(result.requested, 3);
  assert.equal(result.quotes.length, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].symbol, 'AAPL');
  assert.match(result.failed[0].error, /upstream 500/);
});

test('one failure does not lose the others', async () => {
  const result = await plugin({ failing: ['TSLA'] }).compareStocks(['TSLA', 'AAPL']);
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].symbol, 'AAPL');
});

test('duplicates are collapsed before any request goes out', async () => {
  let calls = 0;
  const p = plugin();
  const inner = p.getStockQuote;
  p.getStockQuote = async (s) => { calls++; return inner(s); };
  const result = await p.compareStocks(['TSLA', 'TSLA', 'TSLA']);
  assert.equal(calls, 1);
  assert.equal(result.requested, 1);
});

test('an empty or non-array request is refused', async () => {
  await assert.rejects(() => plugin().compareStocks([]), /non-empty array/);
  await assert.rejects(() => plugin().compareStocks('TSLA'), /non-empty array/);
});

test('the fan-out is bounded', async () => {
  // Each symbol is one live upstream request and nothing upstream caps the list.
  const many = Array.from({ length: XueqiuPlugin.MAX_COMPARE_SYMBOLS + 1 }, (_, i) => `S${i}`);
  await assert.rejects(() => plugin().compareStocks(many), /Too many symbols/);
});

test('the compare command is declared', () => {
  assert.ok(plugin().commands.find(c => c.command === 'compare'));
});

// --- screener tests ---

const screenerPlugin = (doGetImpl) => {
  const p = new XueqiuPlugin({ logger: { info() {}, warn() {}, error() {} } });
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  p.doGet = doGetImpl || (async () => ({ data: { list: [] } }));
  // Clear cache to avoid interference between tests
  p.cache.flushAll();
  return p;
};

const sampleScreenerResponse = (list) => ({
  data: {
    list: list || [
      { symbol: 'SH600519', name: 'Kweichow Moutai', current: 1800, percent: 2.5, chg: 45, volume: 1234567, exchange: 'SH' },
      { symbol: 'SZ000858', name: 'Wuliangye', current: 150, percent: -1.2, chg: -1.8, volume: 987654, exchange: 'SZ' }
    ]
  }
});

test('screener command is declared', () => {
  assert.ok(plugin().commands.find(c => c.command === 'screener'));
});

test('screenerStocks returns mapped data from API', async () => {
  const p = screenerPlugin(async () => sampleScreenerResponse());
  const result = await p.screenerStocks({ market: 'CN', orderBy: 'volume', order: 'desc', page: 1, size: 2 });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    symbol: 'SH600519',
    name: 'Kweichow Moutai',
    price: 1800,
    percent: 2.5,
    change: 45,
    volume: 1234567,
    market: 'SH'
  });
  assert.deepEqual(result[1], {
    symbol: 'SZ000858',
    name: 'Wuliangye',
    price: 150,
    percent: -1.2,
    change: -1.8,
    volume: 987654,
    market: 'SZ'
  });
});

test('screenerStocks uses cache on second call', async () => {
  let callCount = 0;
  const p = screenerPlugin(async () => {
    callCount++;
    return sampleScreenerResponse();
  });
  await p.screenerStocks({ market: 'CN' });
  assert.equal(callCount, 1);
  await p.screenerStocks({ market: 'CN' });
  assert.equal(callCount, 1); // second call should hit cache
});

test('screenerStocks passes correct params to doGet', async () => {
  let capturedParams;
  const p = screenerPlugin(async (url, { params }) => {
    capturedParams = params;
    return sampleScreenerResponse();
  });
  await p.screenerStocks({ market: 'HK', orderBy: 'percent', order: 'asc', page: 3, size: 5 });
  assert.deepEqual(capturedParams, {
    page: 3,
    size: 5,
    order: 'asc',
    order_by: 'percent',
    market: 'HK',
    type: 'hk'
  });
});

test('screenerStocks defaults to CN, volume, desc, page 1, size 10', async () => {
  let capturedParams;
  const p = screenerPlugin(async (url, { params }) => {
    capturedParams = params;
    return sampleScreenerResponse();
  });
  await p.screenerStocks({});
  assert.deepEqual(capturedParams, {
    page: 1,
    size: 10,
    order: 'desc',
    order_by: 'volume',
    market: 'CN',
    type: 'sh_sz'
  });
});

test('screenerStocks handles US market with type us', async () => {
  let capturedParams;
  const p = screenerPlugin(async (url, { params }) => {
    capturedParams = params;
    return sampleScreenerResponse();
  });
  await p.screenerStocks({ market: 'US' });
  assert.equal(capturedParams.type, 'us');
  assert.equal(capturedParams.market, 'US');
});

test('screenerStocks returns empty array when API returns no list', async () => {
  const p = screenerPlugin(async () => ({ data: {} }));
  const result = await p.screenerStocks({ market: 'CN' });
  assert.deepEqual(result, []);
});

test('screenerStocks handles missing fields gracefully', async () => {
  const p = screenerPlugin(async () => ({
    data: {
      list: [{ symbol: 'TEST' }]
    }
  }));
  const result = await p.screenerStocks({ market: 'CN' });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    symbol: 'TEST',
    name: null,
    price: null,
    percent: null,
    change: null,
    volume: null,
    market: null
  });
});

test('screenerStocks coerces string page/size from AI extraction', async () => {
  let capturedParams;
  const p = screenerPlugin(async (url, { params }) => { capturedParams = params; return sampleScreenerResponse(); });
  await p.screenerStocks({ market: 'cn', order: 'ASC', page: '2', size: '20' });
  assert.deepEqual(capturedParams, { page: 2, size: 20, order: 'asc', order_by: 'volume', market: 'CN', type: 'sh_sz' });
});

test('screenerStocks rejects bad input instead of guessing', async () => {
  let called = false;
  const p = screenerPlugin(async () => { called = true; return sampleScreenerResponse(); });
  await assert.rejects(() => p.screenerStocks({ market: 'JP' }), /Invalid market/);
  await assert.rejects(() => p.screenerStocks({ order: 'up' }), /Invalid order/);
  await assert.rejects(() => p.screenerStocks({ orderBy: 'x;drop' }), /Invalid orderBy/);
  await assert.rejects(() => p.screenerStocks({ page: 0 }), /Invalid page/);
  await assert.rejects(() => p.screenerStocks({ size: 500 }), /Invalid size/);
  assert.equal(called, false);
});

test('execute screener surfaces validation errors as success:false', async () => {
  const p = screenerPlugin(async () => sampleScreenerResponse());
  const r = await p.execute({ action: 'screener', market: 'JP' });
  assert.equal(r.success, false);
  assert.match(r.error, /Invalid market/);
  const ok = await p.execute({ action: 'screener', market: 'US', size: 2 });
  assert.equal(ok.success, true);
  assert.equal(ok.data.length, 2);
});
