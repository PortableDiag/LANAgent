// ReAct runs can be cancelled with an AbortSignal and bounded by an opt-in budget
// (context.budget / options.executionBudget). With no budget nothing is raced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReActAgent } from '../../src/services/reasoning/reactAgent.js';

const ACTION = '{"reasoning":"look","action":{"tool":"system","command":"status","params":{}}}';

function agent(respond) {
  const react = new ReActAgent({
    apiManager: { apis: new Map() },
    providerManager: { generateResponse: respond }
  });
  react.calls = 0;
  react.executeAction = async () => { react.calls++; return { success: true, result: 'ok' }; };
  return react;
}

test('an already-aborted signal ends the run as cancelled without calling the model', async () => {
  let asked = 0;
  const react = agent(async () => { asked++; return { content: ACTION }; });
  const ac = new AbortController();
  ac.abort();
  const events = [];
  react.on('cancelled', r => events.push(r));
  const r = await react.run('q', { signal: ac.signal });
  assert.equal(r.success, false);
  assert.equal(r.cancelled, true);
  assert.equal(asked, 0);
  assert.equal(events.length, 1);
  assert.equal(react.getState().cancellation.active, false);
});

test('aborting mid-thought returns promptly as cancelled', async () => {
  const ac = new AbortController();
  // Abort once the model call is actually in flight (a fixed 20 ms timer raced the run's own
  // setup under a loaded full-suite run and aborted before the first iteration began).
  const react = agent(() => { setTimeout(() => ac.abort(), 5); return new Promise(() => {}); }); // never returns
  const r = await react.run('q', { signal: ac.signal });
  assert.equal(r.cancelled, true);
  assert.equal(r.iterations, 1);
});

test('maxToolCalls stops the loop after that many actions', async () => {
  const react = agent(async () => ({ content: ACTION }));
  const r = await react.run('q', { budget: { maxToolCalls: 2 } });
  assert.equal(r.budgetExceeded, true);
  assert.equal(react.calls, 2);
  assert.match(r.reason, /tool-call budget of 2/);
});

test('maxActionDurationMs bounds a slow step; without it a slow thought is not raced', async () => {
  const slow = agent(() => new Promise(r => setTimeout(() => r({ content: '{"reasoning":"x","finalAnswer":"done"}' }), 60)));
  const bounded = await slow.run('q', { budget: { maxActionDurationMs: 10 } });
  assert.equal(bounded.budgetExceeded, true);
  const unbounded = await slow.run('q', {});
  assert.equal(unbounded.success, true);
  assert.equal(unbounded.answer, 'done');
});

test('the thinking prompt carries the Trellis channel and keeps the newest observation long', async () => {
  const { ReActAgent } = await import('../../src/services/reasoning/reactAgent.js');
  const agent = Object.create(ReActAgent.prototype);
  agent.tools = [];
  agent.getPrioritizedTools = () => [];
  const long = 'step '.repeat(400);
  const history = [
    { type: 'observation', content: 'old ' + 'x'.repeat(2000) },
    { type: 'observation', content: { tool: 'trellis-notes', command: 'readCard', result: { card: { id: 250, body: 'stale ' + 'v'.repeat(3000) } } } },
    { type: 'observation', content: { tool: 'trellis-notes', command: 'readCard', result: { card: { id: 250, body: 'walkthrough ' + 'w'.repeat(6000) } } } },
    { type: 'observation', content: long }
  ];
  const prompt = agent.buildThinkingPrompt('do you all agree on the steps?', history, { channel: 'This request came from a shared Trellis channel (card 21).' });
  assert.match(prompt, /## Where This Came From:\n.*card 21/);
  assert.ok(prompt.includes(long.substring(0, 1900)), 'the newest observation is not cut at 500 characters');
  assert.ok(!prompt.includes('x'.repeat(1300)), 'older observations stay short');
  assert.ok(prompt.includes('w'.repeat(5900)), 'the newest read of a card is kept whole enough to follow (card 250 is ~6 KB)');
  assert.ok(!prompt.includes('v'.repeat(300)), 'an earlier read of the same card is replaced, not repeated');
});

test('the reasoning prompt tells the agent to act, not to ask for confirmation of what was asked', () => {
  const agent = Object.create(ReActAgent.prototype);
  agent.tools = [];
  agent.getPrioritizedTools = () => [];
  const prompt = agent.buildThinkingPrompt('add your block to card 243', [], {});
  assert.match(prompt, /never ask them to confirm or restate a request they already made/);
  assert.doesNotMatch(prompt, /Ask for clarification if the task is unclear/);
});

test('out of steps: a closing reply that is another step gets one plain-text retry (card 21 #2298)', async () => {
  const prompts = [];
  const react = agent(async (p) => { prompts.push(p); return { content: prompts.length === 1 ? ACTION : 'Read cards 250 and 251; found no test plan. Not done: the reply.' }; });
  const history = [{ type: 'action', content: { tool: 'trellis-notes', command: 'readCard' } }, { type: 'observation', content: 'card 250 body' }];
  const answer = await react._closingAnswer('reply to ReapptionAgent', history, {}, {});
  assert.equal(answer, 'Read cards 250 and 251; found no test plan. Not done: the reply.');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Did: .*readCard/);
  assert.doesNotMatch(prompts[1], /search_tools/);
});

test('out of steps: plain prose is the closing answer; JSON twice is none', async () => {
  const prose = agent(async () => ({ content: 'I read three cards and did not finish.' }));
  assert.equal(await prose._closingAnswer('q', [], {}, {}), 'I read three cards and did not finish.');
  const stubborn = agent(async () => ({ content: ACTION }));
  assert.equal(await stubborn._closingAnswer('q', [], {}, {}), null);
});

test('firstStep returns the first action without running it (routing dry run, 2026-10-28)', async () => {
  const react = agent(async () => ({ content: ACTION }));
  const step = await react.firstStep('what is the status', {});
  assert.deepEqual(step.action, { tool: 'system', command: 'status', params: {} });
  assert.equal(step.reasoning, 'look');
  assert.equal(react.calls, 0, 'nothing executed');
});
