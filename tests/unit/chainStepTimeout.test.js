// A plan step that buys from the store looks over every model first; at 60 s the chain cut it off and the
// cut-off step went on alone (DELTA, 2026-11-07). A plugin can ask for more time per action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginChainProcessor } from '../../src/core/pluginChainProcessor.js';

const withPlugin = (instance) => new PluginChainProcessor({ apiManager: { getPlugin: (n) => (n === 'p' ? instance : null) } });

test('a plugin that asks for more time gets it for that action only', () => {
  const c = withPlugin({ stepTimeoutMs: (a) => (a === 'buy' ? 360000 : 0) });
  assert.equal(c.stepTimeoutFor({ plugin: 'p', action: 'buy' }), 360000);
  assert.equal(c.stepTimeoutFor({ plugin: 'p', action: 'browse' }), 60000);
});

test('no plugin, no method, a short ask or a throw all keep the default', () => {
  assert.equal(withPlugin(null).stepTimeoutFor({ plugin: 'x', action: 'buy' }), 60000);
  assert.equal(withPlugin({}).stepTimeoutFor({ plugin: 'p', action: 'buy' }), 60000);
  assert.equal(withPlugin({ stepTimeoutMs: () => 1000 }).stepTimeoutFor({ plugin: 'p', action: 'buy' }), 60000);
  assert.equal(withPlugin({ stepTimeoutMs: () => { throw new Error('x'); } }).stepTimeoutFor({ plugin: 'p', action: 'buy' }), 60000);
});

test('the store plugin asks for minutes on a buy', async () => {
  const { default: B } = await import('../../src/api/plugins/botsandborgs.js');
  const b = new B({});
  assert.ok(b.stepTimeoutMs('buy') >= 300000);
  assert.equal(b.stepTimeoutMs('browse'), 0);
});
