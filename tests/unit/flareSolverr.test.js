import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { logger } from '../../src/utils/logger.js';

let flareSolverr;
const originalLoggerInfo = logger.info;
const originalAxiosPost = axios.post;

before(async () => {
  // silence logger during tests
  logger.info = () => {};
  flareSolverr = await import('../../src/utils/flareSolverr.js');
});

after(() => {
  logger.info = originalLoggerInfo;
  axios.post = originalAxiosPost;
});

describe('fsRequestPost', () => {
  it('sends a request.post command with correct body', async () => {
    const solution = { url: 'http://example.com', status: 200, response: '<html>', cookies: [], userAgent: 'ua' };
    let capturedBody;
    axios.post = async (url, body) => {
      capturedBody = body;
      return { data: { status: 'ok', solution } };
    };
    const result = await flareSolverr.fsRequestPost('http://example.com', 'key=val', { maxTimeout: 30000 });
    assert.deepStrictEqual(capturedBody, {
      cmd: 'request.post',
      url: 'http://example.com',
      postData: 'key=val',
      maxTimeout: 30000
    });
    assert.deepStrictEqual(result, solution);
  });

  it('passes optional userAgent, cookies, session, headers', async () => {
    let capturedBody, capturedConfig;
    axios.post = async (url, body, config) => {
      capturedBody = body;
      capturedConfig = config;
      return { data: { status: 'ok', solution: {} } };
    };
    await flareSolverr.fsRequestPost('http://example.com', 'data', {
      userAgent: 'test-ua',
      cookies: [{ name: 'c', value: 'v' }],
      session: 'sid123',
      headers: { 'X-Custom': '1' }
    });
    assert.deepStrictEqual(capturedBody, {
      cmd: 'request.post',
      url: 'http://example.com',
      postData: 'data',
      maxTimeout: 60000,
      userAgent: 'test-ua',
      cookies: [{ name: 'c', value: 'v' }],
      session: 'sid123'
    });
    assert.ok(capturedConfig.headers['Content-Type'] === 'application/json');
    assert.ok(capturedConfig.headers['X-Custom'] === '1');
  });

  it('throws on FlareSolverr error status', async () => {
    axios.post = async () => ({ data: { status: 'error', message: 'bad' } });
    await assert.rejects(
      () => flareSolverr.fsRequestPost('http://example.com', 'data'),
      { message: /FlareSolverr error: bad/ }
    );
  });

  it('throws when solution is missing', async () => {
    axios.post = async () => ({ data: { status: 'ok' } });
    await assert.rejects(
      () => flareSolverr.fsRequestPost('http://example.com', 'data'),
      { message: /no solution/ }
    );
  });

  it('marks FlareSolverr unavailable on connection refused', async () => {
    const err = new Error('connect ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    axios.post = async () => { throw err; };
    await assert.rejects(
      () => flareSolverr.fsRequestPost('http://example.com', 'data'),
      { message: /unreachable/ }
    );
    // Verify that isFlareSolverrAvailable returns false without calling axios
    let axiosCalled = false;
    axios.post = async () => { axiosCalled = true; throw new Error('should not be called'); };
    const available = await flareSolverr.isFlareSolverrAvailable();
    assert.strictEqual(available, false);
    assert.strictEqual(axiosCalled, false);
  });

  it('logs success with response length and cookie count', async () => {
    const logCalls = [];
    logger.info = (msg) => logCalls.push(msg);
    const solution = { url: 'http://example.com', status: 200, response: 'abc', cookies: [{}, {}] };
    axios.post = async () => ({ data: { status: 'ok', solution } });
    await flareSolverr.fsRequestPost('http://example.com', 'data');
    assert.ok(logCalls.some(m => m.includes('POST 200') && m.includes('3 bytes') && m.includes('2 cookies')));
  });
});

describe('fsRequestGet (unchanged by the shared helper)', () => {
  it('sends request.get without postData and logs without a POST label', async () => {
    const logCalls = [];
    logger.info = (msg) => logCalls.push(msg);
    let capturedBody;
    axios.post = async (url, body) => {
      capturedBody = body;
      return { data: { status: 'ok', solution: { status: 200, response: 'ab', cookies: [] } } };
    };
    await flareSolverr.fsRequestGet('http://example.com/g');
    assert.deepStrictEqual(capturedBody, { cmd: 'request.get', url: 'http://example.com/g', maxTimeout: 60000 });
    assert.ok(logCalls.includes('[FlareSolverr] 200 http://example.com/g (2 bytes, 0 cookies)'));
  });

  it('does not retry: one FlareSolverr call per request', async () => {
    let calls = 0;
    axios.post = async () => { calls++; throw new Error('boom'); };
    await assert.rejects(() => flareSolverr.fsRequestGet('http://example.com'), { message: /request failed: boom/ });
    assert.strictEqual(calls, 1);
  });
});

describe('fsRequestPost input validation', () => {
  it('rejects a non-string postData before calling FlareSolverr', async () => {
    let called = false;
    axios.post = async () => { called = true; return { data: {} }; };
    await assert.rejects(() => flareSolverr.fsRequestPost('http://example.com', { a: 1 }), { message: /urlencoded string/ });
    assert.strictEqual(called, false);
  });
});
