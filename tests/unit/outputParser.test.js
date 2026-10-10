import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OutputParser,
  JSONOutputParser,
  StructuredOutputParser,
  ParseError
} from '../../src/services/outputParser.js';

test('valid JSON is parsed untouched (URLs with //, apostrophes)', () => {
  const p = new JSONOutputParser();
  const raw = '{"url": "https://example.com/a//b", "text": "don\'t /* keep */ this", "n": 1}';
  assert.deepEqual(p.parse(raw), {
    url: 'https://example.com/a//b',
    text: "don't /* keep */ this",
    n: 1
  });
});

test('repairJSON leaves double-quoted string content alone', () => {
  const raw = '{"a": "it\'s // not a comment", "b": "x, }"}';
  assert.equal(OutputParser.repairJSON(raw), raw);
});

test('repairs trailing commas, comments, single quotes and bare keys', () => {
  const p = new JSONOutputParser();
  const raw = `\`\`\`json
{
  // the plugin
  plugin: 'web',
  action: 'search', /* inline */
  params: { query: 'it\\'s "quoted"', tags: ['a', 'b',], },
  ok: true,
  nothing: null,
}
\`\`\``;
  assert.deepEqual(p.parse(raw), {
    plugin: 'web',
    action: 'search',
    params: { query: 'it\'s "quoted"', tags: ['a', 'b'] },
    ok: true,
    nothing: null
  });
});

test('prose apostrophes around the JSON do not break repair', () => {
  const p = new JSONOutputParser();
  assert.deepEqual(p.parse("Here's the result: {a: 1,} — hope that's right"), { a: 1 });
});

test('repair can be disabled', () => {
  const p = new OutputParser(null, { repair: false });
  assert.throws(() => p.parse('{a: 1}'), ParseError);
});

test('unrepairable input still throws ParseError with the original message', () => {
  const p = new JSONOutputParser();
  assert.throws(() => p.parse('{"a": }'), err => err instanceof ParseError && /Invalid JSON/.test(err.message));
});

test('StructuredOutputParser validates repaired output against its schema', () => {
  const p = new StructuredOutputParser({
    type: 'object',
    properties: { plugin: { type: 'string' }, confidence: { type: 'number' } },
    required: ['plugin']
  });
  assert.deepEqual(p.parse("{plugin: 'x', confidence: 0.5,}"), { plugin: 'x', confidence: 0.5 });
});
