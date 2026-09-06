import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import axios from 'axios';
import { BitNetProvider } from '../../src/providers/bitnet.js';

const MODELS = ['BitNet-b1.58-2B-4T', 'BitNet-b1.58-3B-4T'];

// The BitNet server is llama.cpp: /health for liveness, /v1/models for the
// OpenAI-compatible model list. Stubbing axios keeps this dependency-free —
// no live server, no network.
const stubServer = (models = MODELS) => mock.method(axios, 'get', (url) => {
  if (url.includes('/health')) return Promise.resolve({ status: 200, data: { status: 'ok' } });
  if (url.includes('/v1/models')) {
    return Promise.resolve({ data: { data: models.map(id => ({ id })) } });
  }
  return Promise.reject(new Error('Unexpected URL'));
});

const provider = () => new BitNetProvider({ baseUrl: 'http://localhost:8080' });

test('BitNetProvider initializes and lists models', async (t) => {
  t.after(() => mock.restoreAll());
  const axiosGetMock = stubServer();

  const p = provider();
  await p.initialize();

  assert.equal(p.serverOnline, true);
  assert.deepEqual(p.availableModels, MODELS);
  assert.equal(axiosGetMock.mock.calls.length, 2);
});

test('listModels reports the server list alongside the active model', async (t) => {
  t.after(() => mock.restoreAll());
  stubServer();

  const p = provider();
  const result = await p.listModels();

  assert.deepEqual(result.models, MODELS);
  assert.equal(result.currentModel, p.models.chat,
    'the caller needs to know which of the listed models is actually in use');
});

test('switchModel makes the new model the active one', async (t) => {
  t.after(() => mock.restoreAll());
  stubServer();

  const p = provider();
  const result = await p.switchModel(MODELS[1]);

  assert.equal(result.success, true);
  assert.equal(result.newModel, MODELS[1]);
  assert.equal(p.models.chat, MODELS[1],
    'switching must move the field generateResponse() actually reads, not just report success');
});

test('switchModel refuses a model the server does not offer', async (t) => {
  t.after(() => mock.restoreAll());
  stubServer();

  const p = provider();
  const before = p.models.chat;
  await assert.rejects(() => p.switchModel('no-such-model'), /not available/);
  assert.equal(p.models.chat, before,
    'a rejected switch must leave the active model untouched');
});

test('switchModel refuses an empty model name', async (t) => {
  t.after(() => mock.restoreAll());
  stubServer();

  await assert.rejects(() => provider().switchModel(), /Model name is required/);
});

test('the new commands are declared and dispatched by execute()', async (t) => {
  t.after(() => mock.restoreAll());
  stubServer();

  const p = provider();
  const declared = p.commands.map(c => c.command);
  assert.ok(declared.includes('listmodels'), 'listmodels must be advertised');
  assert.ok(declared.includes('switchmodel'), 'switchmodel must be advertised');

  // A command declared but not wired into execute() is the recurring failure here.
  assert.deepEqual((await p.execute('listmodels')).models, MODELS);
  assert.equal((await p.execute('switchmodel', { modelName: MODELS[1] })).newModel, MODELS[1]);
  await assert.rejects(() => p.execute('switchmodel', {}), /Missing required parameter/);
});
