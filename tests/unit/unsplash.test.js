import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import UnsplashPlugin from '../../src/api/plugins/unsplash.js';

const photo = (id) => ({
  id,
  urls: { regular: `r-${id}`, thumb: `t-${id}` },
  alt_description: `desc ${id}`,
  user: { name: `Photographer ${id}`, links: { html: `https://example.com/${id}` } }
});

describe('UnsplashPlugin getRandomPhoto filters', () => {
  let plugin;
  let originalGet;
  let captured;

  beforeEach(() => {
    plugin = new UnsplashPlugin({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
    plugin.config.apiKey = 'test-api-key';
    originalGet = axios.get;
    captured = null;
  });
  afterEach(() => { axios.get = originalGet; });

  const respond = (data) => { axios.get = async (url, config) => { captured = { url, config }; return { data }; }; };

  it('passes every filter through and returns an array when count > 1', async () => {
    respond([photo('1'), photo('2'), photo('3')]);
    const result = await plugin.getRandomPhoto({
      orientation: 'landscape', count: 3, collections: 'abc,def', username: 'photographer_handle'
    });
    assert.equal(captured.url, 'https://api.unsplash.com/photos/random');
    assert.equal(captured.config.headers.Authorization, 'Client-ID test-api-key');
    assert.deepEqual(captured.config.params, {
      orientation: 'landscape', count: 3, collections: 'abc,def', username: 'photographer_handle'
    });
    assert.ok(Array.isArray(result.data));
    assert.equal(result.data.length, 3);
    assert.equal(result.data[0].photographer.name, 'Photographer 1');
  });

  it('returns a single object without count (backward compatible)', async () => {
    respond(photo('single'));
    const result = await plugin.getRandomPhoto({ query: 'test' });
    assert.deepEqual(captured.config.params, { query: 'test' });
    assert.equal(Array.isArray(result.data), false);
    assert.equal(result.data.id, 'single');
  });

  it('count: 1 still returns a single object even though the API sends an array', async () => {
    respond([photo('only')]);
    const result = await plugin.getRandomPhoto({ count: 1 });
    assert.equal(result.data.id, 'only');
  });

  it('accepts a count given as text from a plain-language request', async () => {
    respond([photo('a'), photo('b')]);
    await plugin.getRandomPhoto({ count: '2' });
    assert.equal(captured.config.params.count, 2);
  });

  it('rejects a bad orientation, out-of-range or fractional count, and query with topics', async () => {
    respond(photo('x'));
    await assert.rejects(plugin.getRandomPhoto({ orientation: 'diagonal' }), /orientation/);
    await assert.rejects(plugin.getRandomPhoto({ count: 31 }), /count/);
    await assert.rejects(plugin.getRandomPhoto({ count: 0 }), /count/);
    await assert.rejects(plugin.getRandomPhoto({ count: 2.5 }), /count/);
    await assert.rejects(plugin.getRandomPhoto({ query: 'nature', topics: 'wallpapers' }), /cannot be combined/);
    assert.equal(captured, null, 'no request is sent for invalid input');
  });
});
