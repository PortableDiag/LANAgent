import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionPickedAsChange } from '../../src/core/aiIntentDetector.js';

test('a question the classifier maps to a change is answered, not run (git.commit, 2026-10-27)', () => {
  const commit = { plugin: 'git', action: 'commit' };
  const send = { plugin: 'textx', action: 'send' };
  assert.equal(questionPickedAsChange('Hey can you see my phone?', commit), true);
  assert.equal(questionPickedAsChange('Do I have any recent texts from Wayne?', send), true);
  assert.equal(questionPickedAsChange('can you commit the changes?', commit), false, 'asks for the change');
  assert.equal(questionPickedAsChange('Can you text mom I am late?', send), false);
  assert.equal(questionPickedAsChange('Alice, could you send Sam the file?', send), false);
  assert.equal(questionPickedAsChange('Send Adam a text', send), false, 'not a question');
  assert.equal(questionPickedAsChange('what is on my phone', { plugin: 'textx', action: 'status' }), false, 'a read');
});

test('a voice note to someone is hinted to textx send (2026-10-28: it asked a clarifying question)', async () => {
  const { AIIntentDetector } = await import('../../src/core/aiIntentDetector.js');
  const d = new AIIntentDetector({ apiManager: { apis: new Map([['textx', { enabled: true }]]) } });
  d.getDynamicIntents = () => ({ 2033: { plugin: 'textx', action: 'send' }, 2034: { plugin: 'textx', action: 'status' } });
  assert.equal(d._regexIntentHint('Send Adam V a voice note audio text message reminding him not to blab about Mars'), 2033);
  assert.equal(d._regexIntentHint('tell Sam I got his voice message'), null);
  // 2026-10-28 live test: no "text"/"message" in it, a number for the recipient; it ran voice.test.
  assert.equal(d._regexIntentHint('Send 5599402727 a voice note saying this is a test of ALICE voice notes'), 2033);
  assert.equal(d._regexIntentHint('send me a voice note of that'), null, 'a voice note for the user is not a text');
});
