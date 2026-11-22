// "Text Jo and tell him…" was picked as sendEmail by the classifier (2026-11-21): a text request is a text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailPickedForText } from '../../src/core/aiIntentDetector.js';

test('email picked for a text request is caught; a request that says email keeps it', () => {
  const email = { plugin: 'email', action: 'send' };
  assert.equal(emailPickedForText('Text Jo and tell him he can see your new avatar in telegram and ask him for feedback', email), true);
  assert.equal(emailPickedForText('Send Jo a text saying hi', email), true);
  assert.equal(emailPickedForText('Text Jo the email address of the store', email), false, 'says email');
  assert.equal(emailPickedForText('Email Jo about the avatar', email), false);
  assert.equal(emailPickedForText('Text Jo hi', { plugin: 'textx', action: 'send' }), false);
});
