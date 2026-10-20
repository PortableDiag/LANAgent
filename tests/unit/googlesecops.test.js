import test from 'node:test';
import assert from 'node:assert/strict';
import GoogleSecOpsPlugin from '../../src/api/plugins/googlesecops.js';
import axios from 'axios';

test('listAllRules follows pagination and aggregates every rule', async () => {
  const plugin = new GoogleSecOpsPlugin({ logger: console });
  plugin.config = { baseUrl: 'https://secops.example', accessToken: 'token' };

  const requests = [];
  plugin.listRules = async ({ pageSize, pageToken, forceRefresh }) => {
    requests.push({ pageSize, pageToken, forceRefresh });

    if (!pageToken) {
      return {
        success: true,
        data: { rules: [{ id: 'r1' }], nextPageToken: 'page-2' }
      };
    }
    if (pageToken === 'page-2') {
      return {
        success: true,
        data: { rules: [{ id: 'r2' }], next_page_token: 'page-3' }
      };
    }
    return { success: true, data: { rules: [{ id: 'r3' }] } };
  };

  const result = await plugin.execute({
    action: 'listAllRules',
    pageSize: 2,
    forceRefresh: true
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.data.rules, [
    { id: 'r1' },
    { id: 'r2' },
    { id: 'r3' }
  ]);
  assert.equal(result.data.pageCount, 3);
  assert.equal(result.data.totalRules, 3);
  assert.deepEqual(
    requests.map(({ pageToken }) => pageToken),
    [undefined, 'page-2', 'page-3']
  );
  assert.ok(requests.every(request => request.pageSize === 2));
  assert.ok(requests.every(request => request.forceRefresh === true));
});

test('getDetection requires detectionId', async () => {
  const plugin = new GoogleSecOpsPlugin({ logger: console });
  plugin.config = { baseUrl: 'https://secops.example', accessToken: 'token' };

  const result = await plugin.execute({ action: 'getDetection' });
  assert.equal(result.success, false);
  assert.match(result.error, /Missing required parameter: detectionId/);
});

test('getDetection fetches and caches a detection', async () => {
  const plugin = new GoogleSecOpsPlugin({ logger: console });
  plugin.config = { baseUrl: 'https://secops.example', accessToken: 'token' };

  // Mock cache to observe get / set without real TTL
  const cacheStore = new Map();
  plugin.cache = {
    get: (key) => cacheStore.get(key),
    set: (key, val) => { cacheStore.set(key, val); }
  };

  const mockDetection = { id: 'det-1', state: 'ALERT' };
  let axiosGetCalls = 0;
  const originalGet = axios.get;
  axios.get = async (url, config) => {
    axiosGetCalls++;
    if (url === 'https://secops.example/v1alpha/detectionengine/detections/det-1') {
      return { data: mockDetection };
    }
    throw new Error('Unexpected URL');
  };

  try {
    // First call – should fetch from the API
    const result1 = await plugin.execute({ action: 'getDetection', detectionId: 'det-1' });
    assert.equal(result1.success, true);
    assert.deepEqual(result1.data, mockDetection);
    assert.equal(result1.cached, undefined);
    assert.equal(axiosGetCalls, 1);

    // Verify cache was populated
    const cachedData = cacheStore.get('googlesecops:detections:get:det-1');
    assert.deepEqual(cachedData, mockDetection);

    // Second call – should be served from cache without making another HTTP request
    const result2 = await plugin.execute({ action: 'getDetection', detectionId: 'det-1' });
    assert.equal(result2.success, true);
    assert.deepEqual(result2.data, mockDetection);
    assert.equal(result2.cached, true);
    assert.equal(axiosGetCalls, 1);
  } finally {
    axios.get = originalGet;
  }
});

test('getDetection handles HTTP errors', async () => {
  const plugin = new GoogleSecOpsPlugin({ logger: console });
  plugin.config = { baseUrl: 'https://secops.example', accessToken: 'token' };

  const originalGet = axios.get;
  axios.get = async () => {
    const error = new Error('Bad request');
    error.response = { status: 400, data: { error: { message: 'Invalid ID' } } };
    throw error;
  };

  try {
    const result = await plugin.execute({ action: 'getDetection', detectionId: 'bad' });
    assert.equal(result.success, false);
    assert.match(result.error, /HTTP 400: Invalid ID/);
  } finally {
    axios.get = originalGet;
  }
});
