import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePlainTextSignature } from '../../src/utils/emailSignatureHelper.js';

test('plain-text signature lists the provided fields and strips the URL scheme', () => {
  const sig = generatePlainTextSignature({
    name: 'Alex Example', title: 'Engineer', email: 'alex@example.com',
    phone: '+1 555 0100', website: 'https://example.com', organization: 'Example Org',
    disclaimer: 'Confidential.'
  });
  assert.equal(sig, [
    'Alex Example', 'Engineer', 'Example Org', '---',
    'Email: alex@example.com', 'Phone: +1 555 0100', 'Web: example.com', '', 'Confidential.'
  ].join('\n'));
});

test('missing fields are omitted, never printed as undefined', () => {
  const sig = generatePlainTextSignature({ name: 'Alex Example' });
  assert.equal(sig, 'Alex Example\n---');
  assert.doesNotMatch(generatePlainTextSignature({}), /undefined/);
});
