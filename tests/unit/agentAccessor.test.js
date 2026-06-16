import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Import the module under test. agentAccessor is a module-level singleton, so
// these named exports operate on a single shared instance. We exercise the
// real node-cache-backed storage path (node-cache is an installed dependency).
const {
  setGlobalAgent,
  getAgentState,
  getAgentStateHistory,
  getStateTransitionEvents
} = await import('../../src/core/agentAccessor.js');

test('agentAccessor tracks state history and transition events', () => {
  const mockAgent = {
    erc8004AgentId: 'test-agent-123',
    name: 'TestAgent',
    apiManager: {
      apis: new Map([
        ['plugin1', { enabled: true, instance: { description: 'Test Plugin 1' } }],
        ['plugin2', { enabled: false, instance: { description: 'Test Plugin 2' } }]
      ])
    }
  };

  // Set agent to trigger the 'initialized' transition (previous was null).
  setGlobalAgent(mockAgent);

  // Get current state (this should store a snapshot).
  const state = getAgentState();

  // Verify state structure.
  assert.equal(state.status, 'active');
  assert.equal(state.agentId, 'test-agent-123');
  assert.equal(state.plugins.length, 2);
  assert.equal(state.plugins[0].name, 'plugin1');
  assert.equal(state.plugins[0].enabled, true);
  assert.equal(state.plugins[1].name, 'plugin2');
  assert.equal(state.plugins[1].enabled, false);

  // Verify history was stored and is retrievable.
  const history = getAgentStateHistory(10);
  assert.ok(history.length >= 1, 'expected at least one state snapshot');
  assert.equal(history[0].agentId, 'test-agent-123');

  // Verify transition events. The 'initialized' transition must carry the
  // correct type (the regression this PR fixes) and the agentId from
  // event.agent.erc8004AgentId.
  const events = getStateTransitionEvents();
  assert.ok(events.length >= 1, 'expected at least one transition event');
  const initEvent = events.find((e) => e.type === 'initialized');
  assert.ok(initEvent, 'expected an "initialized" transition event');
  assert.equal(initEvent.type, 'initialized');
  assert.equal(initEvent.data.agentId, 'test-agent-123');
});

test('reconfigured transition carries type and current agentId', () => {
  // Re-set to a different agent instance to trigger 'reconfigured'.
  const newAgent = { erc8004AgentId: 'test-agent-456', name: 'TestAgent2' };
  setGlobalAgent(newAgent);

  const events = getStateTransitionEvents();
  const reconf = events.find((e) => e.type === 'reconfigured');
  assert.ok(reconf, 'expected a "reconfigured" transition event');
  assert.equal(reconf.type, 'reconfigured');
  assert.equal(reconf.data.agentId, 'test-agent-456');
  assert.equal(reconf.data.currentAgentId, 'test-agent-456');
  assert.equal(reconf.data.previousAgentId, 'test-agent-123');
});
