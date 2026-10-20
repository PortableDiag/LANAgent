import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeConfig, cpusFromShares, validateEnv } from '../../src/api/external/routes/sandbox.js';

test('validateRuntimeConfig accepts in-bounds values', () => {
  const validated = validateRuntimeConfig({ memory: 512, cpuShares: 512, timeout: 15 });
  assert.deepEqual(validated, { memory: 512, cpuShares: 512, timeout: 15 });
});

test('validateRuntimeConfig returns empty object for omitted config', () => {
  assert.deepEqual(validateRuntimeConfig(), {});
  assert.deepEqual(validateRuntimeConfig({}), {});
});

test('validateRuntimeConfig rejects out-of-bounds values', () => {
  assert.throws(() => validateRuntimeConfig({ memory: 64 }), /Memory must be between/);
  assert.throws(() => validateRuntimeConfig({ memory: 2048 }), /Memory must be between/);
  assert.throws(() => validateRuntimeConfig({ cpuShares: 50 }), /CPU shares must be between/);
  assert.throws(() => validateRuntimeConfig({ cpuShares: 4096 }), /CPU shares must be between/);
  assert.throws(() => validateRuntimeConfig({ timeout: 0 }), /Timeout must be between/);
  assert.throws(() => validateRuntimeConfig({ timeout: 31 }), /Timeout must be between/);
  assert.throws(() => validateRuntimeConfig({ memory: 'abc' }), /Memory must be between/);
});

test('cpusFromShares maps the relative scale onto the 2-CPU allowance', () => {
  assert.equal(cpusFromShares(undefined), 2); // unset = today's fixed limit
  assert.equal(cpusFromShares(1024), 2);
  assert.equal(cpusFromShares(512), 1);
  assert.equal(cpusFromShares(100), 0.2);
});

test('validateEnv returns [key, value] pairs for a valid object', () => {
  assert.deepEqual(validateEnv({ MY_VAR: 'value', _UNDER: '', ANOTHER: '123' }),
    [['MY_VAR', 'value'], ['_UNDER', ''], ['ANOTHER', '123']]);
});

test('validateEnv treats omitted, null or empty env as none', () => {
  assert.deepEqual(validateEnv(), []);
  assert.deepEqual(validateEnv(null), []);
  assert.deepEqual(validateEnv({}), []);
});

test('validateEnv rejects a non-object env', () => {
  assert.throws(() => validateEnv([]), /env must be an object/);
  assert.throws(() => validateEnv('A=1'), /env must be an object/);
});

test('validateEnv rejects more than 10 variables', () => {
  const env = {};
  for (let i = 0; i < 11; i++) env[`VAR${i}`] = 'val';
  assert.throws(() => validateEnv(env), /Maximum 10 environment variables allowed/);
});

test('validateEnv rejects bad names: symbols, spaces, empty, leading digit, "=" and over-long', () => {
  for (const key of ['INVALID-KEY', 'key with space', '', '1ABC', 'A=B', 'A'.repeat(65)]) {
    assert.throws(() => validateEnv({ [key]: 'val' }), /Invalid env name/, key);
  }
  assert.doesNotThrow(() => validateEnv({ ['A'.repeat(64)]: 'v' }));
});

test('validateEnv keeps a __proto__ key visible to validation instead of dropping it', () => {
  const env = JSON.parse('{"__proto__": "x"}');
  assert.deepEqual(validateEnv(env), [['__proto__', 'x']]);
});

test('validateEnv rejects non-string, over-long, newline and NUL values', () => {
  for (const v of [123, true, null, { a: 1 }]) {
    assert.throws(() => validateEnv({ KEY: v }), /must be a string/);
  }
  assert.throws(() => validateEnv({ KEY: 'A'.repeat(257) }), /exceeds maximum length of 256/);
  assert.doesNotThrow(() => validateEnv({ KEY: 'A'.repeat(256) }));
  for (const v of ['a\nb', 'a\rb', 'a\0b']) {
    assert.throws(() => validateEnv({ KEY: v }), /must not contain newlines or NUL/);
  }
});
