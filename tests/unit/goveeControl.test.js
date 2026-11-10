// Govee answers HTTP 200 {code:400,"Device is offline"} for an unreachable light; that is a failure, retried (2026-11-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import GoveePlugin from '../../src/api/plugins/govee.js';

const ID = 'C1:9C:D4:AD:FC:34:6C:EA';
function rig(answers) {
  const notes = [];
  const p = new GoveePlugin({ notify: async (m) => notes.push(m) });
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  p.config.apiKey = 'k'; p.config.aiControlEnabled = true;
  p.deviceCache.set(ID, { device: ID, sku: 'H6008', deviceName: 'Master Toilet' });
  p.lastDeviceFetch = Date.now();
  p.resolveDeviceName = async (n) => (/toilet/i.test(n) ? ID : null); // the name matching itself needs Mongo (aliases)
  const sent = [];
  p.makeRequest = async (ep, m, data) => { if (ep === "/device/state") return { payload: { capabilities: [] } }; sent.push(data.capability); return answers.length > 1 ? answers.shift() : answers[0]; };
  return { p, sent, notes };
}
const ok = (type) => ({ code: 200, msg: 'success', capability: { type, state: { status: 'success' } } });
const offline = { code: 400, msg: 'Device is offline. Please check the Wi-Fi connection.', capability: { state: { status: 'failure', errorMsg: 'Device is offline. Please check the Wi-Fi connection.' } } };

test('a white turns the light on first, by name, without fromAI (the ReAct path)', async () => {
  const { p, sent } = rig([ok('on')]);
  const r = await p.execute({ action: 'temperature', device: 'Master Toilet', kelvin: 6500 });
  assert.equal(r.success, true);
  assert.deepEqual(sent.map(c => [c.instance, c.value]), [['powerSwitch', 1], ['colorTemperatureK', 6500]]);
});

test('offline is a failure, not a success, and says so', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p } = rig([offline]);
  const run = p.execute({ action: 'color', device: 'Master Toilet', color: 'bright white', fromAI: true });
  for (let i = 0; i < 10; i++) { await Promise.resolve(); t.mock.timers.tick(5000); await new Promise(r => setImmediate(r)); }
  const r = await run;
  assert.equal(r.success, false);
  assert.equal(r.offline, true);
  assert.match(r.error, /offline/);
  clearInterval(p.retryTimer);
});

test('a light that comes back is retried in the background and the owner is told', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p, notes } = rig([offline, offline, offline, offline, offline, offline, ok('on')]);
  const run = p.execute({ action: 'power', device: 'Master Toilet', state: 'on', fromAI: true });
  for (let i = 0; i < 6; i++) { await Promise.resolve(); t.mock.timers.tick(5000); await new Promise(r => setImmediate(r)); }
  const r = await run;
  assert.equal(r.success, false);
  for (let i = 0; i < 12 && !notes.length; i++) { t.mock.timers.tick(15000); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }
  assert.match(notes[0] || '', /back online/);
  assert.equal(p.pendingRetry, null);
});

test('"retry" right after an offline light repeats that command', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p, sent } = rig([ok('x')]);
  p.pendingRetry = { deviceId: ID, sku: 'H6008', name: 'Master Toilet', steps: [{ capability: 'devices.capabilities.on_off', value: 1 }], at: Date.now() };
  const r = await p.execute({ action: 'temperature', device: 'waiting', fromAI: true });
  assert.equal(r.success, true);
  assert.equal(sent.length, 1);
});


test('an accepted command on a light Govee shows offline is not "done"; repeat redoes the last command', async () => {
  const g = new (await import('../../src/api/plugins/govee.js')).default({});
  g.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const calls = [];
  let online = false;
  g.makeRequest = async (route, method, body) => {
    calls.push(route);
    if (route === '/device/state') return { payload: { capabilities: [{ instance: 'online', state: { value: online } }] } };
    return { code: 200, capability: { state: { status: 'success' } } };
  };
  const job = { deviceId: 'AA', sku: 'H1', name: 'Master Toilet', steps: [{ capability: 'devices.capabilities.on_off', value: 1 }] };
  const orig = global.setTimeout; global.setTimeout = (fn) => orig(fn, 0);
  try {
    const r = await g.runSteps(job);
    assert.equal(r.success, false); assert.equal(r.offline, true);
    online = true;
    assert.equal(g.recentCommand().name, 'Master Toilet');
    const again = await g.runSteps(g.recentCommand());
    assert.equal(again.success, true);
  } finally { global.setTimeout = orig; }
});

test('execute accepts repeat: it redoes the last command, or says there is none', async () => {
  const g = new (await import('../../src/api/plugins/govee.js')).default({});
  g.logger = { info() {}, warn() {}, error() {}, debug() {} };
  g.checkRateLimit = () => true;
  const none = await g.execute({ action: 'repeat' });
  assert.equal(none.success, false); assert.match(none.error, /no recent light command/);
  g.makeRequest = async (route) => route === '/device/state' ? { payload: { capabilities: [] } } : { code: 200, capability: { state: { status: 'success' } } };
  g.lastCommand = { deviceId: 'AA', sku: 'H1', name: 'Master Toilet', steps: [{ capability: 'devices.capabilities.on_off', value: 1 }], at: Date.now() };
  const r = await g.execute({ action: 'repeat' });
  assert.equal(r.success, true, JSON.stringify(r));
});
