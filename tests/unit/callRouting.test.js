// 2026-11-21: "Call Jo and explain how you use botsnborgs…" went to the store's video action (a clip of a phone call
// sent to Jo instead of a call), and "Tell me whether you called Jo yet" was answered with tool markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOnePhoneCall } from '../../src/core/pluginChainProcessor.js';

test('a request that opens by asking for a call is one phone call, store words and all', () => {
  assert.equal(isOnePhoneCall('Call Jo and explain how you use botsnborgs to set and animate store or custom avatars and agents learn and teach new moves. Tell him to check telegram for examples.'), true);
  assert.equal(isOnePhoneCall('Send me a video of you in your assistant avatar doing the roger rabbit'), false);
  assert.equal(isOnePhoneCall('Call Jo and then text Sam'), false, 'a chain');
});

test('"did you call Jo yet" reads the recent calls; a new call request does not', async () => {
  const { AIIntentDetector } = await import('../../src/core/aiIntentDetector.js');
  const d = new AIIntentDetector({ apiManager: { apis: new Map([['dialx', { enabled: true, instance: { paired: true } }]]) } });
  d.getDynamicIntents = () => ({ 4001: { plugin: 'dialx', action: 'call' }, 4002: { plugin: 'dialx', action: 'recents' } });
  assert.equal(d._regexIntentHint('Tell me whether you called Jo yet.'), 4002);
  assert.equal(d._regexIntentHint('Did you call him yet?'), 4002);
  assert.equal(d._regexIntentHint('have you called Jo?'), 4002);
  assert.equal(d._regexIntentHint('Call Jo and tell him happy birthday'), 4001);
});
