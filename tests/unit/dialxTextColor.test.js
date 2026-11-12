/** Call 142 (2026-11-11): asked to show a colour, the call voice could only describe it. Now it texts a swatch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalHex, colorSwatch, canTextColor, sessionConfig } from '../../src/services/textx/dialxRealtime.js';
import { withinMs } from '../../src/api/plugins/dialx.js';

test('hex colours are normalised; anything else is refused', () => {
  assert.equal(normalHex('#a1b2c3'), '#A1B2C3');
  assert.equal(normalHex('a1b2c3'), '#A1B2C3');
  assert.equal(normalHex('#abc'), '#AABBCC');
  assert.equal(normalHex('mushroom'), null);
  assert.equal(normalHex('#12345'), null);
});

test('the swatch is a PNG', async () => {
  const png = await colorSwatch('#8B7D6B', 'Mushroom <&>');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(png.length > 1000);
});

test('only a one-to-one call with a number can text a colour', () => {
  assert.equal(canTextColor({ number: '+15550001' }), true);
  assert.equal(canTextColor({ ownerOnLine: true }), true);
  assert.equal(canTextColor({}), false);
  assert.equal(canTextColor({ number: '+1', group: true }), false);
  assert.equal(canTextColor({ number: '+1', peerAgent: true }), false);
  assert.equal(canTextColor({ number: '+1', test: true }), false);
});

test('the session offers text_color only when it can text', () => {
  const names = (c) => c.session.tools.map(t => t.name);
  assert.ok(names(sessionConfig({ instructions: 'x', canText: true })).includes('text_color'));
  assert.ok(!names(sessionConfig({ instructions: 'x' })).includes('text_color'));
});

test('withinMs gives up on a model that never answers', async () => {
  await assert.rejects(withinMs(new Promise(() => {}), 30), /no answer/);
  assert.equal(await withinMs(Promise.resolve(5), 1000), 5);
});
