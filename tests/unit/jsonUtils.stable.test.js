import test from 'node:test';
import assert from 'node:assert/strict';

import { stableJsonStringify } from '../../src/utils/jsonUtils.js';

test('stableJsonStringify: identical output regardless of key insertion order', () => {
  const a = { foo: 1, bar: 2, nested: { y: 'b', x: 'a' } };
  const b = { nested: { x: 'a', y: 'b' }, bar: 2, foo: 1 };
  assert.equal(stableJsonStringify(a), stableJsonStringify(b));
});

test('stableJsonStringify: default lexical key order', () => {
  const out = stableJsonStringify({ c: 3, a: 1, b: 2 });
  assert.equal(out, '{"a":1,"b":2,"c":3}');
});

test('stableJsonStringify: respects custom comparator', () => {
  const reverse = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
  const out = stableJsonStringify({ a: 1, b: 2, c: 3 }, { comparator: reverse });
  assert.equal(out, '{"c":3,"b":2,"a":1}');
});

test('stableJsonStringify: indentation', () => {
  const out = stableJsonStringify({ b: 2, a: 1 }, { spaces: 2 });
  assert.equal(out, '{\n  "a": 1,\n  "b": 2\n}');
});

test('stableJsonStringify: handles circular refs without throwing', () => {
  const obj = { a: 1 };
  obj.self = obj;
  const out = stableJsonStringify(obj);
  assert.ok(out.includes('[Circular]'));
});

test('stableJsonStringify: BigInt → string', () => {
  assert.equal(stableJsonStringify({ n: 42n }), '{"n":"42"}');
});

test('stableJsonStringify: Date → ISO 8601', () => {
  const d = new Date('2026-01-15T03:30:00.000Z');
  assert.equal(stableJsonStringify({ d }), '{"d":"2026-01-15T03:30:00.000Z"}');
});

test('stableJsonStringify: Buffer → base64', () => {
  const b = Buffer.from('hello');
  assert.equal(stableJsonStringify({ b }), '{"b":"aGVsbG8="}');
});

test('stableJsonStringify: Map serializes with sorted keys', () => {
  const m = new Map();
  m.set('z', 1);
  m.set('a', 2);
  assert.equal(stableJsonStringify(m), '{"a":2,"z":1}');
});

test('stableJsonStringify: Set serializes as array sorted by JSON of items', () => {
  const s = new Set([3, 1, 2]);
  assert.equal(stableJsonStringify(s), '[1,2,3]');
});

test('stableJsonStringify: arrays preserve order, undefined → null', () => {
  assert.equal(stableJsonStringify([1, undefined, 3]), '[1,null,3]');
});

test('stableJsonStringify: ignoreUndefined drops undefined object entries (matches JSON.stringify default)', () => {
  const out = stableJsonStringify({ a: 1, b: undefined, c: 3 });
  assert.equal(out, '{"a":1,"c":3}');
});

test('stableJsonStringify: nested ordering is stable too', () => {
  const a = { outer: { z: 1, a: 2, m: { c: 3, b: 4 } } };
  const b = { outer: { m: { b: 4, c: 3 }, a: 2, z: 1 } };
  assert.equal(stableJsonStringify(a), stableJsonStringify(b));
});

test('stableJsonStringify: comparator that throws falls back to default sort, never throws', () => {
  const broken = () => { throw new Error('boom'); };
  const out = stableJsonStringify({ b: 2, a: 1 }, { comparator: broken });
  assert.equal(out, '{"a":1,"b":2}');
});
