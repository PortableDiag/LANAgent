/**
 * getFunctionLogs and monitorFunctionExecution.
 *
 * The shipped test could not run at all: it imported `retryOperation` and
 * `safeJsonParse` from `../../utils/...` (from tests/unit that resolves outside
 * the repo — the real path is `../../src/utils/...`), and it called
 * `mock.module()`, which needs Node 22 plus --experimental-test-module-mocks and
 * is undefined on the Node 20 this project targets.
 *
 * These assert the request that actually goes on the wire, because both defects
 * repaired here were in the URL and the query parameters — a stubbed method
 * cannot see either.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import axios from 'axios';
import GoogleCloudFunctionsPlugin from '../../src/api/plugins/googlecloudfunctions.js';

const plugin = () => {
  const p = new GoogleCloudFunctionsPlugin({ services: { get: () => null } });
  p.config.apiKey = 'test-token';
  p.logger = { info: () => {}, warn: () => {}, error: () => {} };
  p.validateParams = () => {};
  return p;
};

// Capture requests rather than stubbing the methods under test.
const capture = () => {
  const gets = [];
  const posts = [];
  const og = axios.get;
  const op = axios.post;
  axios.get = async (url, cfg) => { gets.push({ url, cfg }); return { data: { timeSeries: [] } }; };
  axios.post = async (url, body, cfg) => { posts.push({ url, body, cfg }); return { data: { entries: [] } }; };
  return { gets, posts, restore: () => { axios.get = og; axios.post = op; } };
};

test('getFunctionLogs posts to the Cloud Logging entries:list endpoint', async (t) => {
  const cap = capture();
  t.after(cap.restore);

  const res = await plugin().getFunctionLogs({ projectId: 'proj', functionName: 'fn' });

  assert.equal(res.success, true);
  assert.equal(cap.posts[0].url, 'https://logging.googleapis.com/v2/entries:list');
  assert.deepEqual(cap.posts[0].body.resourceNames, ['projects/proj']);
});

test('getFunctionLogs scopes the filter to the named function', async (t) => {
  const cap = capture();
  t.after(cap.restore);

  await plugin().getFunctionLogs({ projectId: 'proj', functionName: 'fn' });

  const { filter } = cap.posts[0].body;
  assert.match(filter, /resource\.type="cloud_function"/);
  assert.match(filter, /resource\.labels\.function_name="fn"/);
});

test('getFunctionLogs appends a caller filter and honours the limit', async (t) => {
  const cap = capture();
  t.after(cap.restore);

  await plugin().getFunctionLogs({
    projectId: 'proj', functionName: 'fn', filter: 'severity>=ERROR', limit: 100
  });

  assert.match(cap.posts[0].body.filter, /severity>=ERROR/);
  assert.equal(cap.posts[0].body.pageSize, 100);
  assert.equal(cap.posts[0].body.orderBy, 'timestamp desc');
});

test('getFunctionLogs defaults the limit to 50', async (t) => {
  const cap = capture();
  t.after(cap.restore);

  await plugin().getFunctionLogs({ projectId: 'proj', functionName: 'fn' });
  assert.equal(cap.posts[0].body.pageSize, 50);
});

test('monitorFunctionExecution targets Cloud Monitoring, not Cloud Logging', async (t) => {
  const cap = capture();
  t.after(cap.restore);

  await plugin().monitorFunctionExecution({ projectId: 'proj', functionName: 'fn' });

  // Time series are a Monitoring v3 resource. The logging host would 404.
  assert.equal(cap.gets[0].url, 'https://monitoring.googleapis.com/v3/projects/proj/timeSeries');
});

test('monitorFunctionExecution sends dotted query parameters', async (t) => {
  const cap = capture();
  t.after(cap.restore);

  await plugin().monitorFunctionExecution({ projectId: 'proj', functionName: 'fn' });

  const params = cap.gets[0].cfg.params;
  // Google's REST mapping spells nested request fields with dots. The
  // underscore forms are unrecognised and silently dropped, which would widen
  // the interval to the API default rather than raise an error.
  for (const key of ['interval.startTime', 'interval.endTime',
    'aggregation.perSeriesAligner', 'aggregation.alignmentPeriod', 'aggregation.groupByFields']) {
    assert.ok(key in params, `${key} must be sent`);
  }
  for (const key of Object.keys(params)) {
    assert.ok(!key.includes('_'), `${key} uses the underscore spelling`);
  }
  assert.equal(params['aggregation.perSeriesAligner'], 'ALIGN_RATE');
});

test('the monitoring window follows the requested duration', async (t) => {
  const cap = capture();
  t.after(cap.restore);

  const p = plugin();
  await p.monitorFunctionExecution({ projectId: 'proj', functionName: 'fn', duration: '1d' });
  await p.monitorFunctionExecution({ projectId: 'proj', functionName: 'fn' });

  const span = (i) => {
    const q = cap.gets[i].cfg.params;
    return (Date.parse(q['interval.endTime']) - Date.parse(q['interval.startTime'])) / 1000;
  };
  assert.equal(span(0), 86400, '1d');
  assert.equal(span(1), 3600, 'the default is 1h');
});

test('an unknown duration falls back to an hour rather than NaN', async (t) => {
  const cap = capture();
  t.after(cap.restore);

  await plugin().monitorFunctionExecution({
    projectId: 'proj', functionName: 'fn', duration: 'fortnight'
  });

  const q = cap.gets[0].cfg.params;
  assert.equal((Date.parse(q['interval.endTime']) - Date.parse(q['interval.startTime'])) / 1000, 3600);
});

test('execution metrics cover every status unless one is requested', async (t) => {
  const cap = capture();
  t.after(cap.restore);

  const p = plugin();
  await p.monitorFunctionExecution({ projectId: 'proj', functionName: 'fn' });
  assert.ok(!cap.gets[0].cfg.params.filter.includes('metric.label.status'),
    'a command called "monitor execution" must not silently report successes only');

  await p.monitorFunctionExecution({ projectId: 'proj', functionName: 'fn', status: 'error' });
  assert.match(cap.gets[1].cfg.params.filter, /metric\.label\.status="error"/);
});

test('both commands are declared and dispatched by execute()', async (t) => {
  const cap = capture();
  t.after(cap.restore);

  const p = plugin();
  const declared = p.commands.map(c => c.command);
  assert.ok(declared.includes('getFunctionLogs'));
  assert.ok(declared.includes('monitorFunctionExecution'));

  // execute() validates action against the command list, so registration matters.
  assert.equal((await p.execute({ action: 'getFunctionLogs', projectId: 'p', functionName: 'f' })).success, true);
  assert.equal((await p.execute({ action: 'monitorFunctionExecution', projectId: 'p', functionName: 'f' })).success, true);
});
