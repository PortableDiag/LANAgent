import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import AviationstackPlugin from '../../src/api/plugins/aviationstack.js';

test('coalesces identical in-flight flight status requests', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const originalGet = axios.get;

  axios.get = async (...args) => {
    calls++;
    await gate;
    return { data: { data: [{ flight_status: 'active' }] } };
  };

  const agent = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    providerManager: null
  };
  const plugin = new AviationstackPlugin(agent);
  plugin.config.apiKey = 'test-key';
  plugin.initialized = true;

  try {
    const first = plugin.getFlightStatus({
      flightNumber: 'BA2490',
      date: '2023-10-12'
    });
    const second = plugin.getFlightStatus({
      flightNumber: 'BA2490',
      date: '2023-10-12'
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);

    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, secondResult);
  } finally {
    release();
    axios.get = originalGet;
  }
});

function batchPlugin(responder) {
  const agent = { logger: { info() {}, warn() {}, error() {}, debug() {} }, providerManager: null };
  const plugin = new AviationstackPlugin(agent);
  plugin.config.apiKey = 'test-key';
  plugin.initialized = true;
  const calls = [];
  plugin.requestFlights = async (params) => { calls.push(params); return responder(params); };
  return { plugin, calls };
}

test('getMultipleFlightStatus queries one flight_iata per request (API takes a single code)', async () => {
  const { plugin, calls } = batchPlugin(p => ({ data: { data: [{ flight: { iata: p.flight_iata }, flight_status: p.flight_iata === 'BA2490' ? 'active' : 'landed' }] } }));
  const r = await plugin.getMultipleFlightStatus({ flightNumbers: ['ba2490', 'UA1234', 'BA2490'], date: '2023-10-12' });
  assert.equal(r.success, true);
  assert.deepEqual(calls.map(c => c.flight_iata), ['BA2490', 'UA1234']);
  assert.ok(calls.every(c => c.flight_date === '2023-10-12' && c.access_key === 'test-key'));
  assert.equal(r.data.BA2490[0].flight_status, 'active');
  assert.equal(r.data.UA1234[0].flight_status, 'landed');
  assert.deepEqual(r.notFound, []);
});

test('getMultipleFlightStatus accepts a comma/space separated string', async () => {
  const { plugin, calls } = batchPlugin(() => ({ data: { data: [{}] } }));
  const r = await plugin.getMultipleFlightStatus({ flightNumbers: 'BA2490, UA1234 LH400' });
  assert.equal(r.success, true);
  assert.deepEqual(calls.map(c => c.flight_iata), ['BA2490', 'UA1234', 'LH400']);
});

test('getMultipleFlightStatus reports not-found and per-flight errors separately', async () => {
  const { plugin } = batchPlugin(p => {
    if (p.flight_iata === 'XX1') throw new Error('boom');
    return { data: { data: p.flight_iata === 'BA2490' ? [{ flight_status: 'active' }] : [] } };
  });
  const r = await plugin.getMultipleFlightStatus({ flightNumbers: ['BA2490', 'UA1234', 'XX1'] });
  assert.equal(r.success, true);
  assert.deepEqual(Object.keys(r.data), ['BA2490']);
  assert.deepEqual(r.notFound, ['UA1234']);
  assert.deepEqual(r.errors, { XX1: 'boom' });
});

test('getMultipleFlightStatus fails when every lookup errors', async () => {
  const { plugin } = batchPlugin(() => { throw new Error('quota'); });
  const r = await plugin.getMultipleFlightStatus({ flightNumbers: ['BA2490', 'UA1234'] });
  assert.equal(r.success, false);
  assert.match(r.error, /quota/);
});

test('getMultipleFlightStatus rejects empty and oversized input without calling the API', async () => {
  const { plugin, calls } = batchPlugin(() => ({ data: { data: [] } }));
  assert.equal((await plugin.getMultipleFlightStatus({ flightNumbers: [] })).success, false);
  assert.equal((await plugin.getMultipleFlightStatus({})).success, false);
  const many = Array.from({ length: 11 }, (_, i) => `AA${i}`);
  assert.match((await plugin.getMultipleFlightStatus({ flightNumbers: many })).error, /At most 10/);
  assert.equal(calls.length, 0);
});

test('execute routes getMultipleFlightStatus', async () => {
  const { plugin } = batchPlugin(() => ({ data: { data: [{}] } }));
  const r = await plugin.execute({ action: 'getMultipleFlightStatus', flightNumbers: ['BA2490'] });
  assert.equal(r.success, true);
});
