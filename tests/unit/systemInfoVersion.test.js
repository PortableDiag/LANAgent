/**
 * "What version of LANAgent are you running?" routed to system.info, whose type extractor had no
 * version type, so it picked "network" and answered with the network interfaces (2026-10-20).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import SystemPlugin from '../../src/api/plugins/system.js';
import { AIIntentDetector } from '../../src/core/aiIntentDetector.js';

test('system.info type "version" answers with the agent version, not network interfaces', async () => {
  const plugin = new SystemPlugin({ version: '9.8.7', config: {} });
  const r = await plugin.getSystemInfo({ type: 'version' });
  assert.equal(r.success, true);
  assert.match(r.result, /LANAgent:\*\* v9\.8\.7/);
  assert.doesNotMatch(r.result, /Network/);
});

test('the type extractor accepts "version" and tolerates punctuation', async () => {
  for (const [reply, want] of [['version', 'version'], ['Version.', 'version'], ['network', 'network'], ['no idea', 'all']]) {
    const d = Object.create(AIIntentDetector.prototype);
    d.agent = { providerManager: { generateAux: async () => ({ content: reply }) } };
    assert.deepEqual(await d.extractSystemInfoParams('What version of LANAgent are you running?'), { type: want }, reply);
  }
});
