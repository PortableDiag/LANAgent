import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { UncensoredProvider } from '../../src/providers/uncensored.js';

const makeProvider = () => {
  const provider = new UncensoredProvider({ apiKey: 'test-key' });
  provider.apiKey = 'test-key'; // skip initialize() — no network/env needed
  return provider;
};

test('_updateRateLimit: remaining=0 survives parsing (the value that matters)', () => {
  const provider = makeProvider();
  provider._updateRateLimit({
    'x-ratelimit-limit': '100',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '30'
  });
  assert.equal(provider.rateLimiter.limit, 100);
  assert.equal(provider.rateLimiter.remaining, 0);
  assert.ok(provider.rateLimiter.resetTime > Date.now());
  assert.equal(provider._isRateLimited(), true);
});

test('_updateRateLimit: absent headers leave state untouched; epoch reset handled', () => {
  const provider = makeProvider();
  provider._updateRateLimit({ 'content-type': 'application/json' });
  assert.deepEqual(provider.rateLimiter, { limit: null, remaining: null, resetTime: 0 });

  // epoch-seconds dialect
  const epochSec = Math.floor(Date.now() / 1000) + 120;
  provider._updateRateLimit({ 'x-ratelimit-reset': String(epochSec) });
  assert.equal(provider.rateLimiter.resetTime, epochSec * 1000);
});

test('_shouldThrottle: only with known limit+remaining below 10%', () => {
  const provider = makeProvider();
  assert.equal(provider._shouldThrottle(), false); // unknown state

  provider.rateLimiter = { limit: 100, remaining: 5, resetTime: 0 };
  assert.equal(provider._shouldThrottle(), true);

  provider.rateLimiter = { limit: 100, remaining: 50, resetTime: 0 };
  assert.equal(provider._shouldThrottle(), false);

  provider.rateLimiter = { limit: null, remaining: 5, resetTime: 0 };
  assert.equal(provider._shouldThrottle(), false);
});

test('_waitForRateLimitReset: fails fast on long windows instead of hanging', async () => {
  const provider = makeProvider();
  provider.rateLimiter = { limit: 100, remaining: 0, resetTime: Date.now() + 120_000 };
  await assert.rejects(
    () => provider._waitForRateLimitReset(),
    /rate limited — resets in/
  );

  // not limited → returns immediately
  provider.rateLimiter = { limit: 100, remaining: 50, resetTime: 0 };
  await provider._waitForRateLimitReset();
});

test('generateResponse captures rate-limit headers from the live response', async (t) => {
  const provider = makeProvider();
  const origPost = axios.post;
  axios.post = async () => ({
    data: {
      choices: [{ message: { content: 'Hello!' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    },
    headers: {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '5',
      'x-ratelimit-reset': '30'
    }
  });
  t.after(() => { axios.post = origPost; });

  const result = await provider.generateResponse('Test prompt');
  assert.equal(result.content, 'Hello!');
  assert.equal(provider.rateLimiter.limit, 100);
  assert.equal(provider.rateLimiter.remaining, 5);
  assert.equal(provider._shouldThrottle(), true);
});

test('healthCheck extends the base shape with rate-limit info', () => {
  const provider = makeProvider();
  provider.rateLimiter = { limit: 100, remaining: 0, resetTime: Date.now() + 60_000 };
  const health = provider.healthCheck();
  assert.equal(health.configured, true);
  assert.equal(health.rateLimit.isRateLimited, true);
  assert.equal(health.rateLimit.remaining, 0);
  // base fields still present
  assert.ok('totalRequests' in health);
  assert.ok('isActive' in health);
});
