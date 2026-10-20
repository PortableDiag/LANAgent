import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GabProvider } from '../../src/providers/gab.js';
import { logger } from '../../src/utils/logger.js';

const transient = () => Object.assign(new Error('Service Unavailable'), { status: 503 });

function provider(config, models = ['arya', 'gpt-4o']) {
  const p = new GabProvider(config);
  p.availableModels = new Set(models);
  p.updateMetrics = async () => {};
  const calls = [];
  p.client = {
    chat: {
      completions: {
        create: async (req) => {
          calls.push(req.model);
          if (req.model === 'arya') throw transient();
          return { model: req.model, choices: [{ message: { content: 'ok' } }], usage: {} };
        }
      }
    }
  };
  return { p, calls };
}

describe('GabProvider model fallback', () => {
  const saved = {};
  before(() => {
    for (const k of ['error', 'warn', 'info']) { saved[k] = logger[k]; logger[k] = () => {}; }
  });
  after(() => { for (const k of Object.keys(saved)) logger[k] = saved[k]; });

  it('is off by default: the original error is thrown and no second model is called', async () => {
    const { p, calls } = provider({});
    await assert.rejects(() => p.generateResponse('hi'), /Service Unavailable/);
    assert.equal(calls.includes('gpt-4o'), false);
  });

  it('when enabled, a transient failure is answered by the alternative model', async () => {
    const { p, calls } = provider({ enableFallback: true });
    const res = await p.generateResponse('hi');
    assert.equal(res.content, 'ok');
    assert.equal(res.model, 'gpt-4o');
    assert.equal(calls.at(-1), 'gpt-4o');
    assert.equal(p.metrics.fallbacks, 1);
  });

  it('does not override a model the caller asked for', async () => {
    const { p } = provider({ enableFallback: true });
    await assert.rejects(() => p.generateResponse('hi', { model: 'arya' }), /Service Unavailable/);
  });

  it('does not fall back to a model Gab does not list', async () => {
    const { p } = provider({ enableFallback: true }, ['arya']);
    await assert.rejects(() => p.generateResponse('hi'), /Service Unavailable/);
  });

  it('does not fall back on a non-transient error', () => {
    const { p } = provider({ enableFallback: true });
    assert.equal(p.shouldFallback(Object.assign(new Error('bad key'), { status: 401 }), {}), false);
    assert.equal(p.shouldFallback(transient(), {}), true);
    assert.equal(p.shouldFallback(transient(), { stream: true }), false);
  });
});
