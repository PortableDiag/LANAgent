import test from 'node:test';
import assert from 'node:assert/strict';
import MapsPlugin from '../../src/api/plugins/maps.js';

function createPlugin() {
  return new MapsPlugin(null);
}

test('geocodeBatch rejects non-array and oversized input', async () => {
  const plugin = createPlugin();

  assert.deepEqual(
    await plugin.geocodeBatch({ queries: 'Eiffel Tower' }),
    { success: false, error: 'queries must be an array' }
  );

  assert.deepEqual(
    await plugin.geocodeBatch({
      queries: Array.from({ length: 26 }, (_, i) => `place ${i}`)
    }),
    { success: false, error: 'queries may contain at most 25 items' }
  );
});

test('reverseBatch rejects non-array and oversized input', async () => {
  const plugin = createPlugin();

  assert.deepEqual(
    await plugin.reverseBatch({ points: {} }),
    { success: false, error: 'points must be an array' }
  );

  assert.deepEqual(
    await plugin.reverseBatch({
      points: Array.from({ length: 26 }, () => [0, 0])
    }),
    { success: false, error: 'points may contain at most 25 items' }
  );
});

test('empty batches return successful ordered result collections without network calls', async () => {
  const plugin = createPlugin();

  assert.deepEqual(await plugin.geocodeBatch({ queries: [] }), {
    success: true,
    results: [],
    result: 'Nothing to look up.'
  });

  assert.deepEqual(await plugin.reverseBatch({ points: [] }), {
    success: true,
    results: [],
    result: 'Nothing to look up.'
  });
});

test('batch commands are exposed and executable through the plugin API', async () => {
  const plugin = createPlugin();

  assert.ok(plugin.commands.some(command => command.command === 'geocodeBatch'));
  assert.ok(plugin.commands.some(command => command.command === 'reverseBatch'));

  assert.deepEqual(await plugin.execute({
    action: 'geocodeBatch',
    queries: []
  }), {
    success: true,
    results: [],
    result: 'Nothing to look up.'
  });

  assert.deepEqual(await plugin.execute({
    action: 'reverseBatch',
    points: []
  }), {
    success: true,
    results: [],
    result: 'Nothing to look up.'
  });
});

test('a batch keeps per-item failures and summarises every item for chat', async () => {
  const plugin = createPlugin();
  // Points with no coordinates fail inside osm.reverse() before any network call.
  const out = await plugin.reverseBatch({ points: [{}, ['x', 'y']] });
  assert.equal(out.success, true);
  assert.equal(out.results.length, 2);
  assert.ok(out.results.every((r, i) => r.success === false && r.index === i));
  assert.match(out.result, /^1\. .*failed — /m);
  assert.match(out.result, /^2\. x, y: failed — /m);
});

// ---- elevation (Open-Meteo) — axios.get stubbed, no network ----
import axios from 'axios';
import { elevation } from '../../src/services/webtools/osm.js';

async function withAxiosGet(impl, fn) {
  const orig = axios.get;
  axios.get = impl;
  try { return await fn(); } finally { axios.get = orig; }
}

test('elevation action: lat/lon returns metres, feet and a chat line', async () => {
  let calls = 0;
  await withAxiosGet(async (url, cfg) => {
    calls++;
    assert.equal(url, 'https://api.open-meteo.com/v1/elevation');
    assert.deepEqual(cfg.params, { latitude: 39.7392, longitude: -104.9903 });
    return { data: { elevation: [1609.0] } };
  }, async () => {
    const r = await createPlugin().execute({ action: 'elevation', lat: 39.7392, lon: -104.9903 });
    assert.equal(r.success, true, r.error);
    assert.equal(r.elevationM, 1609);
    assert.equal(r.elevationFt, 5279);
    assert.match(r.result, /1609 m \(5279 ft\) above sea level/);
    // second call within the cache window does not hit the API
    await createPlugin().execute({ action: 'elevation', lat: 39.73921, lon: -104.99031 });
  });
  assert.equal(calls, 1);
});

test('elevation: sea level 0 is a real value, a missing value is an error', async () => {
  await withAxiosGet(async () => ({ data: { elevation: [0] } }), async () => {
    assert.equal(await elevation(10.1234, 10.1234), 0);
  });
  await withAxiosGet(async () => ({ data: { elevation: [] } }), async () => {
    const r = await createPlugin().execute({ action: 'elevation', lat: 11.5, lon: 11.5 });
    assert.equal(r.success, false);
    assert.match(r.error, /no elevation data/);
  });
});

test('elevation rejects invalid coordinates before any request', async () => {
  let called = false;
  await withAxiosGet(async () => { called = true; return { data: {} }; }, async () => {
    const r = await createPlugin().execute({ action: 'elevation', lat: 95, lon: 0 });
    assert.equal(r.success, false);
    assert.match(r.error, /not valid coordinates/);
  });
  assert.equal(called, false);
});
