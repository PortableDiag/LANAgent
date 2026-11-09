// Plugins that failed on 2026-11-09 (no key, refused key, dead upstream) answer from a free source instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('weather: a refused Weatherstack key falls back to Open-Meteo in the same shape', async (t) => {
  const { default: W } = await import('../../src/api/plugins/weatherstack.js');
  t.mock.method(axios, 'get', async (url) => {
    if (url.includes('weatherstack')) { const e = new Error('Request failed with status code 401'); e.response = { status: 401 }; throw e; }
    if (url.includes('geocoding')) return { data: { results: [{ name: 'London', country: 'United Kingdom', latitude: 51.5, longitude: -0.1, timezone: 'Europe/London' }] } };
    return { data: { current: { time: 'now', temperature_2m: 11, weather_code: 61, relative_humidity_2m: 80 } } };
  });
  const w = new W({}); w.logger = quiet; w.config.apiKey = 'bad';
  const r = await w.execute({ action: 'getTemperature', location: 'London' });
  assert.deepEqual([r.success, r.data], [true, 11]);
  const d = await w.execute({ action: 'getWeatherDescription', location: 'London' });
  assert.equal(d.data, 'Light rain');
});

test('ip lookup: no ipstack key uses ipwho.is; a bad key answered as HTTP 200 is not a success', async (t) => {
  const { default: P } = await import('../../src/api/plugins/ipstack.js');
  const calls = [];
  t.mock.method(axios, 'get', async (url) => {
    calls.push(url);
    if (url.includes('ipstack')) return { data: { success: false, error: { info: 'invalid access key' } } };
    return { data: { success: true, ip: '8.8.8.8', country: 'United States', city: 'Mountain View', timezone: { id: 'America/Los_Angeles' }, connection: { isp: 'Google' } } };
  });
  const p = new P({}); p.logger = quiet;
  let r = await p.lookup('8.8.8.8');
  assert.deepEqual([r.success, r.source, r.data.country_name], [true, 'ipwho.is', 'United States']);
  p.config.apiKey = 'bad';
  r = await p.lookup('8.8.8.8');
  assert.equal(r.source, 'ipwho.is');
  assert.ok(calls.some(u => u.includes('ipstack')), 'ipstack was tried first');
});

test('huggingface takes the words as text as well as inputs', async () => {
  const { default: H } = await import('../../src/api/plugins/huggingface.js');
  const h = new H({}); h.logger = quiet;
  let seen;
  h.callInference = async (model, body) => { seen = body; return { label: 'POSITIVE' }; };
  h.config.apiKey = 'x'; // no credentials lookup (that needs Mongo)
  await h.execute({ action: 'sentimentAnalysis', text: 'I love this' }).catch(() => {});
  assert.equal(seen?.inputs, 'I love this');
});

test('lyrics: junk uploads that repeat the title as the artist rank last', async (t) => {
  const { default: L } = await import('../../src/api/plugins/lyrics.js');
  t.mock.method(axios, 'get', async () => ({ data: [
    { artistName: 'Bohemian Rhapsody - Queen', trackName: 'Bohemian Rhapsody - Queen', albumName: 'x', plainLyrics: 'a' },
    { artistName: 'Queen', trackName: 'Bohemian Rhapsody', albumName: 'A Night at the Opera', plainLyrics: 'Is this the real life', syncedLyrics: '[00:01]' }
  ] }));
  const l = new L({}); l.logger = quiet;
  const r = await l.execute({ action: 'search', query: 'queen bohemian rhapsody junkrank' });
  assert.equal(r.results[0].artist, 'Queen');
});

test('market data with no Alpha Vantage key: quote from Yahoo, forex from Frankfurter', async (t) => {
  const { default: A } = await import('../../src/api/plugins/alphavantage.js');
  t.mock.method(axios, 'get', async (url) => url.includes('frankfurter')
    ? { data: { date: '2026-11-09', rates: { EUR: 0.9 } } }
    : { data: { chart: { result: [{ meta: { symbol: 'IBM', regularMarketPrice: 248, currency: 'USD' }, timestamp: [1, 2], indicators: { quote: [{ open: [1, 2], high: [1, 2], low: [1, 2], close: [240, 245], volume: [1, 2] }] } }] } } });
  const a = new A({}); a.apiKey = '';
  const q = await a.execute({ action: 'quote', symbol: 'ibm' });
  assert.deepEqual([q.symbol, q.price, q.previousClose, q.change], ['IBM', 248, 240, 8]);
  const f = await a.execute({ action: 'forex', from_currency: 'usd', to_currency: 'eur' });
  assert.equal(f.exchangeRate, 0.9);
});

test('nasa neo with no dates means today', async () => {
  const { default: N } = await import('../../src/api/plugins/nasa.js');
  const n = new N({}); n.apiKey = '';
  const r = await n.getNeo();
  assert.equal(r.error, 'API key not configured', 'it got past the date check');
});

test('paid gateway calls never get the non-commercial free sources (weather, anime)', async (t) => {
  const { default: W } = await import('../../src/api/plugins/weatherstack.js');
  t.mock.method(axios, 'get', async () => { const e = new Error('Request failed with status code 401'); e.response = { status: 401 }; throw e; });
  const w = new W({}); w.logger = quiet; w.config.apiKey = 'bad';
  const r = await w.execute({ action: 'getTemperature', location: 'London', _caller: 'external' });
  assert.equal(r.success, false);
  assert.match(r.error, /401/);
  const { default: A } = await import('../../src/api/plugins/anime.js');
  const a = new A({}); a.logger = quiet; a.jikanDownUntil = Date.now() + 60000;
  const paid = await a.execute({ action: 'top', _caller: 'external' });
  assert.equal(paid.success, false);
  assert.match(paid.error, /Jikan/);
});

test('plugins that now work without a key load enabled; weather stays key-gated', async () => {
  for (const name of ['spoonacular', 'unsplash', 'ipstack']) {
    const { default: P } = await import(`../../src/api/plugins/${name}.js`);
    assert.deepEqual(await new P({}).missingRequiredCredentials(), [], name);
  }
  const { default: W } = await import('../../src/api/plugins/weatherstack.js');
  assert.equal(new W({}).worksWithoutCredentials, undefined);
});
