// "Alice change my Master Toilet light so it's bright white" (2026-11-07): no regex matched, the command ran with no
// device and no value, and the reasoning agent spent 4 minutes looking for the light.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIIntentDetector } from '../../src/core/aiIntentDetector.js';

function detector(answer) {
  const d = Object.create(AIIntentDetector.prototype);
  const asked = [];
  d.agent = { providerManager: { generateAux: async (p) => { asked.push(p); return { content: answer }; } } };
  return { d, asked };
}

test('"change my Master Toilet light so it\'s bright white" gets the device and the white', async () => {
  const { d, asked } = detector('{"device":"Master Toilet","temperature":"bright white"}');
  const p = await d.extractGoveeParameters('temperature', "Alice change my Master Toilet light so it's bright white");
  assert.equal(p.device, 'Master Toilet');
  assert.equal(p.temperature, 'bright white');
  assert.equal(asked.length, 0, 'read without a model call');
});

test('a phrasing no rule reads goes to the model, and only fills what is missing', async () => {
  const { d, asked } = detector('{"device":"Office desk","level":40}');
  const p = await d.extractGoveeParameters('brightness', 'could the office desk one be at forty percent');
  assert.equal(asked.length, 1);
  assert.equal(p.device, 'Office desk');
  assert.equal(p.level, 40);
  assert.equal(p.fromAI, true);
});

test('a broken model answer leaves the parameters as they were', async () => {
  const { d } = detector('sorry, no idea');
  const p = await d.extractGoveeParameters('color', 'paint it all a nice tone');
  assert.equal(p.fromAI, true);
  assert.equal(p.device, undefined);
});

test('the colour rule over-captured device is replaced by "my <name> light"', async () => {
  const { d } = detector('{}');
  const p = await d.extractGoveeParameters('color', "Alice change my Master Toilet light so it's bright white");
  assert.equal(p.device, 'Master Toilet');
  assert.equal(p.color, 'bright white');
});
