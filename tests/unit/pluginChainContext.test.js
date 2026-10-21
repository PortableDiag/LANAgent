import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginChainProcessor } from '../../src/core/pluginChainProcessor.js';

test('a chain step gets the request context a single command gets: the words, who asked, the attached file', async () => {
  const seen = [];
  const agent = {
    config: { name: 'T' },
    apiManager: { getPlugin: () => ({ commands: [{ command: 'send' }] }) },
    executePluginWithLogging: async (plugin, action, params) => { seen.push(params); return { success: true }; }
  };
  const chain = new PluginChainProcessor(agent);
  const file = { filename: 'eyeball.mp4', mimeType: 'video/mp4', base64: 'AA==' };
  await chain.executeStep({ plugin: 'textx', action: 'send', params: { to: 'Wayne', text: 'hi' }, requiresLock: false }, {},
    { userId: '42', originalInput: 'send it to Wayne as a gif', attachedFile: file });
  assert.equal(seen[0]._context.attachedFile, file);
  assert.equal(seen[0]._context.originalInput, 'send it to Wayne as a gif');
  assert.equal(seen[0]._context.userId, '42');
});
