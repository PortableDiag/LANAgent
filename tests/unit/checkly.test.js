/**
 * getCheckResults must build a request Checkly will actually answer.
 *
 * The generated version targeted `/checks/{id}/results` (the real path is
 * `/check-results/{id}`), sent `from`/`to` as ISO strings (the API takes UNIX
 * seconds), invented a `status=SUCCESS|FAILURE|PENDING|QUEUED` filter that does
 * not exist, and allowed a limit of 1000 against a documented ceiling of 100.
 * Each of those fails silently rather than loudly — a wrong path 404s into the
 * catch, and an unrecognised query parameter is simply ignored, which is
 * indistinguishable from "no results in that range".
 *
 * So these assert the URL that goes on the wire, not just that a call was made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import ChecklyPlugin from '../../src/api/plugins/checkly.js';

const BASE = 'https://api.checklyhq.com/v1';

// Build a plugin without touching credentials, mongo or the network. Assigning
// config directly avoids initialize(), which would load PluginSettings.
const plugin = () => {
  const p = new ChecklyPlugin({ services: { get: () => null } });
  p.config = { baseUrl: BASE, apiKey: 'test-key' };
  p.logger = { info: () => {}, warn: () => {}, error: () => {} };
  return p;
};

// Capture the URL rather than stubbing the method under test.
const captureUrl = () => {
  const calls = [];
  const original = axios.get;
  axios.get = async (url) => { calls.push(url); return { data: { data: [], meta: {} } }; };
  return { calls, restore: () => { axios.get = original; } };
};

const queryOf = url => Object.fromEntries(new URL(url).searchParams);

test('targets the documented check-results path', async (t) => {
  const cap = captureUrl();
  t.after(cap.restore);

  const res = await plugin().getCheckResults({ checkId: '12345' });

  assert.equal(res.success, true);
  assert.equal(new URL(cap.calls[0]).pathname, '/v1/check-results/12345',
    'the API exposes /check-results/{checkId}; /checks/{id}/results 404s');
});

test('sends from/to as UNIX seconds, not ISO strings', async (t) => {
  const cap = captureUrl();
  t.after(cap.restore);

  await plugin().getCheckResults({
    checkId: '12345',
    startDate: '2023-01-01T00:00:00Z',
    endDate: '2023-01-01T06:00:00Z'
  });

  const q = queryOf(cap.calls[0]);
  assert.equal(q.from, '1672531200', 'from must be UNIX seconds');
  assert.equal(q.to, '1672552800', 'to must be UNIX seconds');
});

test('accepts a Date and an epoch number for the range', async (t) => {
  const cap = captureUrl();
  t.after(cap.restore);

  await plugin().getCheckResults({
    checkId: '1',
    startDate: new Date('2023-01-01T00:00:00Z'),
    endDate: 1672552800
  });

  const q = queryOf(cap.calls[0]);
  assert.equal(q.from, '1672531200');
  assert.equal(q.to, '1672552800', 'a seconds-epoch number must pass through unscaled');
});

test('rejects an unparseable date instead of sending NaN', async (t) => {
  const cap = captureUrl();
  t.after(cap.restore);

  const res = await plugin().getCheckResults({ checkId: '1', startDate: 'not-a-date' });

  assert.equal(res.success, false);
  assert.match(res.error, /startDate must be a valid date/);
  assert.equal(cap.calls.length, 0, 'nothing should reach the network');
});

test('filters failures with hasFailures, the parameter that exists', async (t) => {
  const cap = captureUrl();
  t.after(cap.restore);

  await plugin().getCheckResults({ checkId: '1', hasFailures: true });
  assert.equal(queryOf(cap.calls[0]).hasFailures, 'true');

  await plugin().getCheckResults({ checkId: '1', hasFailures: false });
  assert.equal(queryOf(cap.calls[1]).hasFailures, 'false',
    'false must be sent, not dropped as falsy');
});

test('enforces the documented limit ceiling of 100', async (t) => {
  const cap = captureUrl();
  t.after(cap.restore);

  const ok = await plugin().getCheckResults({ checkId: '1', limit: 100 });
  assert.equal(ok.success, true);
  assert.equal(queryOf(cap.calls[0]).limit, '100');

  const tooBig = await plugin().getCheckResults({ checkId: '1', limit: 1000 });
  assert.equal(tooBig.success, false);
  assert.match(tooBig.error, /between 1 and 100/);
});

test('validates resultType against the documented values', async (t) => {
  const cap = captureUrl();
  t.after(cap.restore);

  await plugin().getCheckResults({ checkId: '1', resultType: 'attempt' });
  assert.equal(queryOf(cap.calls[0]).resultType, 'ATTEMPT', 'normalised to upper case');

  const bad = await plugin().getCheckResults({ checkId: '1', resultType: 'SUCCESS' });
  assert.equal(bad.success, false,
    'SUCCESS was the invented status value — it is not a resultType');
});

test('omits every filter that was not asked for', async (t) => {
  const cap = captureUrl();
  t.after(cap.restore);

  await plugin().getCheckResults({ checkId: '1' });

  assert.equal(new URL(cap.calls[0]).search, '',
    'an unfiltered call must not send empty or defaulted parameters');
});

test('requires a checkId', async (t) => {
  const cap = captureUrl();
  t.after(cap.restore);

  const res = await plugin().getCheckResults({});
  assert.equal(res.success, false);
  assert.match(res.error, /checkId is required/);
  assert.equal(cap.calls.length, 0);
});

test('the command is declared and dispatched by execute()', async (t) => {
  const cap = captureUrl();
  t.after(cap.restore);

  const p = plugin();
  p.initialize = async () => {};
  p.validateParams = () => {};

  const declared = p.commands.find(c => c.command === 'get_check_results');
  assert.ok(declared, 'get_check_results must be advertised');
  assert.ok(!/status:/.test(declared.usage),
    'usage must not advertise the status filter the API does not support');

  const res = await p.execute({ action: 'get_check_results', checkId: '999' });
  assert.equal(res.success, true);
  assert.equal(new URL(cap.calls[0]).pathname, '/v1/check-results/999');
});
