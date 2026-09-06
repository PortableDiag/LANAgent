/**
 * The summarize action.
 *
 * Two defects the shipped test could not see, because its own fixtures hid them:
 *
 *  - It mocked `generateResponse` as returning a plain string. The real provider
 *    resolves to a result object, so `summary.trim()` threw on every call. A
 *    string fixture has `.trim()`, so the mock made the bug invisible.
 *  - It stubbed `plugin.ragChain.summarizeDocument`, but the method lives on the
 *    plugin, not on the chain — so the stub was never reached, and it asserted
 *    the result equalled a bare string when the method returns an object.
 *
 * And the retrieval was unscoped: `getContext` accepts a `filter`, and without
 * it the "summary of a document" is a similarity search across the entire
 * knowledge base for text resembling the sentence "Summarize content from …".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import KnowledgePlugin from '../../src/api/plugins/knowledge.js';

const CONTEXT = 'Chunk one about the quarterly figures. Chunk two about headcount.';

// A plugin with its RAG chain stubbed at the boundary the method actually uses.
const plugin = ({ response, context = CONTEXT, documentCount = 3 } = {}) => {
  const calls = { getContext: [], generateResponse: [] };
  const p = new KnowledgePlugin({ services: { get: () => null } });
  p.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  p.validateParams = () => {};
  p.ragChain = {
    getContext: async (query, options) => {
      calls.getContext.push({ query, options });
      return { context, documentCount, sources: ['/docs/report.pdf'] };
    },
    llmProvider: {
      generateResponse: async (prompt, options) => {
        calls.generateResponse.push({ prompt, options });
        return response;
      }
    }
  };
  return { p, calls };
};

// What the project's providers actually resolve to.
const providerResult = text => ({ content: text, usage: { total_tokens: 42 } });

test('summarize returns the text, not "[object Object]" or a throw', async () => {
  const { p } = plugin({ response: providerResult('  A concise summary.  ') });

  const result = await p.summarizeDocument({ source: '/docs/report.pdf' });

  assert.equal(result.success, true);
  assert.equal(result.summary, 'A concise summary.',
    'the provider result must be unwrapped and trimmed');
});

test('summarize still accepts a provider that returns a bare string', async () => {
  const { p } = plugin({ response: ' plain string ' });

  assert.equal((await p.summarizeDocument({ source: '/x' })).summary, 'plain string');
});

test('retrieval is scoped to the requested source', async () => {
  const { p, calls } = plugin({ response: providerResult('s') });

  await p.summarizeDocument({ source: '/docs/report.pdf' });

  assert.deepEqual(calls.getContext[0].options.filter, { source: '/docs/report.pdf' },
    'without this the summary can be built from other documents entirely');
});

test('summarize reports the source and the length it was given', async () => {
  const { p, calls } = plugin({ response: providerResult('s') });

  const result = await p.summarizeDocument({ source: '/docs/report.pdf', maxLength: 150 });

  assert.equal(result.source, '/docs/report.pdf');
  assert.equal(result.maxLength, 150);
  assert.equal(result.originalLength, CONTEXT.length);
  assert.match(calls.generateResponse[0].prompt, /no more than 150 words/);
  assert.equal(calls.generateResponse[0].options.maxTokens, 300);
});

test('maxLength defaults to 200 words', async () => {
  const { p, calls } = plugin({ response: providerResult('s') });

  const result = await p.summarizeDocument({ source: '/x' });

  assert.equal(result.maxLength, 200);
  assert.match(calls.generateResponse[0].prompt, /no more than 200 words/);
});

test('an empty knowledge base for that source is an error, not an empty summary', async () => {
  const { p } = plugin({ response: providerResult('s'), context: '', documentCount: 0 });

  await assert.rejects(() => p.summarizeDocument({ source: '/missing.pdf' }),
    /No content found for source: \/missing\.pdf/);
});

test('summarize refuses to run without an initialised RAG system', async () => {
  const { p } = plugin({ response: providerResult('s') });
  p.ragChain = null;

  await assert.rejects(() => p.summarizeDocument({ source: '/x' }), /RAG system not initialized/);
});

test('the command is declared and dispatched by execute()', async () => {
  const { p } = plugin({ response: providerResult('dispatched') });

  const declared = p.commands.find(c => c.command === 'summarize');
  assert.ok(declared, 'summarize must be advertised');

  // execute() validates action against an enum; summarize has to be in it.
  const result = await p.execute({ action: 'summarize', source: '/docs/report.pdf' });
  assert.equal(result.summary, 'dispatched');
});
