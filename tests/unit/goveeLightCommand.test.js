// Plain light commands are read without a model, against the owner's real Govee device names (2026-11-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLightCommand } from '../../src/services/govee/lightCommand.js';
import { GoveeEnhancements } from '../../src/api/plugins/govee-enhancements.js';

const names = ['Master Toilet', 'TVBars', 'Living Room Left', 'Living Room Right', 'Kitchen Strip'];
const colors = Object.keys(GoveeEnhancements.colorNames);
const read = (s) => parseLightCommand(s, names, colors);

test('the sentences that failed on 2026-11-09 run at once', () => {
  assert.deepEqual(read("Alice change my Master Toilet light so it's bright white"), { device: 'Master Toilet', action: 'color', params: { device: 'Master Toilet', color: 'bright white' } });
  assert.equal(read('Alice change my Master Toilet light so the Master Toilet light is bright white.').device, 'Master Toilet');
});

test('on, off, colours, whites, brightness, kelvin', () => {
  assert.deepEqual(read('turn off the toilet light'), { device: 'Master Toilet', action: 'power', params: { device: 'Master Toilet', state: 'off' } });
  assert.equal(read('turn the toilet light on').params.state, 'on');
  assert.equal(read('make the toilet light red').params.color, 'red');
  assert.equal(read('set the kitchen strip to 30%').params.level, 30);
  assert.equal(read('set the toilet light to 4000k').params.kelvin, 4000);
  assert.equal(read('warm white in the master toilet').params.color, 'warm white');
  assert.equal(read('turn on the toilet light and make it blue').params.color, 'blue', 'a colour switches the light on first anyway');
  assert.equal(read('turn off all the lights').device, 'all');
});

test('anything unsure goes to the model', () => {
  assert.equal(read('make the toilet light red at night'), null, 'a schedule');
  assert.equal(read('is the toilet light on?'), null, 'a question');
  assert.equal(read('what colour is the toilet light'), null);
  assert.equal(read('make the living room left and living room right blue'), null, 'two devices');
  assert.equal(read('Still waiting, please retry'), null, 'no device');
  assert.equal(read('I cycled the power'), null);
  assert.equal(read('make the toilet light nice'), null, 'no setting');
  assert.equal(read('make the living room blue'), null, 'two devices match "living"');
});

// 2026-11-10: three asks for one light. Complaints repeat the last command; questions about it do not.
import { isLightComplaint } from '../../src/services/govee/lightCommand.js';
test('a complaint about the light repeats it; a question about it does not', () => {
  for (const yes of ["No, it didn't im sitting in the dark, fix the light", 'Make the damn like bright whole already', 'try again', 'still dark', 'it didnt work', 'hurry up', 'nothing happened'])
    assert.equal(isLightComplaint(yes), true, yes);
  for (const no of ['Why did I have to ask 3 times', 'I asked more than twice', 'Finally', 'Assume if I have to ask more than once, you\'ve failed', 'what lights do I have?'])
    assert.equal(isLightComplaint(no), false, no);
});

test('2026-11-11 follow-ups: pushes repeat, "prove it" reads back, an unnamed light is the one just used', async () => {
  const { isLightComplaint, isLightCheck, parseLightCommand } = await import('../../src/services/govee/lightCommand.js');
  for (const t of ['Do it now', 'Lies', 'NOW NOW', 'do it already!']) assert.equal(isLightComplaint(t), true, t);
  for (const t of ['PROVE IT', 'is it on?', 'did it work?']) assert.equal(isLightCheck(t), true, t);
  assert.equal(isLightCheck('prove the theorem'), false);
  const names = ['Master Toilet', 'TVBars', 'Wifi Thermometer', 'Kitchen Bar 1'];
  const r = parseLightCommand("I'm asking you for the second time to turn the fucking bathroom light on, Alice.", names, [], { recentDevice: 'Master Toilet' });
  assert.equal(r.device, 'Master Toilet');
  assert.equal(r.action, 'power');
  assert.equal(parseLightCommand('turn the kitchen bar light on', names, [], { recentDevice: 'Master Toilet' }).device, 'Kitchen Bar 1');
  assert.equal(parseLightCommand('turn the bathroom light on', names, []), null);
});
