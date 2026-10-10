import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { StdioTransport, SSETransport, TransportClosedError } from '../../src/services/mcp/mcpTransport.js';

const NODE = process.execPath;

test('stdio: a server that exits during startup rejects connect()', async () => {
  const t = new StdioTransport(NODE, ['-e', 'process.exit(3)']);
  t.on('error', () => {});
  await assert.rejects(t.connect(), err => err instanceof TransportClosedError && /exited during startup/.test(err.message));
  assert.equal(t.connected, false);
});

test('stdio: in-flight requests fail at once when the server process dies', async () => {
  // Reads stdin, never answers, exits 300 ms after the first request arrives.
  const script = "process.stdin.once('data', () => setTimeout(() => process.exit(1), 300)); setInterval(() => {}, 1000);";
  const t = new StdioTransport(NODE, ['-e', script]);
  let closed = 0;
  t.on('close', () => { closed++; });
  await t.connect();
  assert.equal(t.connected, true);

  const started = Date.now();
  await assert.rejects(t.request('tools/list', {}, 20000), TransportClosedError);
  assert.ok(Date.now() - started < 5000, 'must not wait out the request timeout');
  assert.equal(t.connected, false);
  assert.equal(closed, 1, "'close' still emitted exactly once for mcpClient");
  assert.equal(t.pendingRequests.size, 0);
  await t.close();
});

test('stdio: close() rejects pending requests with TransportClosedError', async () => {
  const t = new StdioTransport(NODE, ['-e', 'setInterval(() => {}, 1000)']);
  await t.connect();
  const p = t.request('ping', {}, 20000);
  await t.close();
  await assert.rejects(p, TransportClosedError);
});

test('sse: close() destroys the stream without emitting error/close as a remote drop', async () => {
  const t = new SSETransport('http://127.0.0.1:1');
  const reader = new PassThrough();
  t.reader = reader;
  t.connected = true;
  let errors = 0;
  t.on('error', () => { errors++; });
  // mirror the handlers connect() installs
  reader.on('error', () => { if (!t.closing) t.emit('error', new Error('x')); });
  await t.close();
  assert.equal(reader.destroyed, true);
  assert.equal(t.reader, null);
  assert.equal(errors, 0);
});
