// Light schedules run on ALICE's scheduler; before 2026-11-11 none had ever fired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import GoveePlugin from '../../src/api/plugins/govee.js';
import { parseLightSchedule, readTime } from '../../src/services/govee/lightSchedule.js';

const names = ['Master Toilet', 'TVBars', 'Kitchen Bar 1', 'Bathtub', 'Govee Music Sync Box', 'Wifi Thermometer'];
const colors = ['red', 'blue', 'white'];

test('the owner\'s sentence is a daily 7:00 bright-white schedule for Master Toilet', () => {
  const r = parseLightSchedule('Every morning at 7am make the Master Toilet light bright white', names, colors);
  assert.equal(r.device, 'Master Toilet');
  assert.equal(r.action, 'color');
  assert.equal(r.params.color, 'bright white');
  assert.equal(r.cron, '0 7 * * *');
});

test('other days and times; non-schedules are not read as one', () => {
  assert.equal(parseLightSchedule('every night at 11 pm turn off the TVBars', names, colors).cron, '0 23 * * *');
  assert.equal(parseLightSchedule('every weekday at 6:30 turn on kitchen bar 1', names, colors).cron, '30 6 * * 1-5');
  assert.equal(parseLightSchedule('make the Master Toilet light bright white', names, colors), null);
  assert.equal(parseLightSchedule('what happens every morning at 7?', names, colors), null);
  assert.equal(readTime('at 7 at night').hour, 19);
});

function rig() {
  const saved = [];
  const defs = {};
  const agenda = {
    define: (n, fn) => { defs[n] = fn; },
    jobs: async () => saved,
    create: (name, data) => {
      const job = { attrs: { name, data, _id: { toString: () => 'id' + saved.length } }, repeatEvery(c, o) { this.attrs.repeatInterval = c; this.attrs.repeatTimezone = o.timezone; this.attrs.nextRunAt = new Date(); }, async save() { saved.push(this); }, async remove() { saved.splice(saved.indexOf(this), 1); } };
      return job;
    }
  };
  const p = new GoveePlugin({ scheduler: { agenda }, notify: async () => {} });
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  p.deviceCache.set('C1', { device: 'C1', sku: 'H6008', deviceName: 'Master Toilet' });
  p.lastDeviceFetch = Date.now();
  p.resolveDeviceName = async (n) => (/toilet/i.test(n) ? 'C1' : null);
  return { p, saved, defs };
}

test('the fast path\'s schedule is saved on the scheduler and runs the light command', async () => {
  const { p, saved, defs } = rig();
  await p.defineSchedulerJobs();
  const r = await p.execute({ action: 'schedules', operation: 'create', device: 'Master Toilet', lightAction: 'color', lightParams: { color: 'bright white' }, cron: '0 7 * * *', label: 'every day', fromAI: true });
  assert.equal(r.success, true, r.error);
  assert.match(r.message, /Master Toilet will set to bright white every day at 7:00 AM/);
  assert.equal(saved[0].attrs.repeatInterval, '0 7 * * *');
  assert.equal(saved[0].attrs.name, 'govee-light-schedule');
  let ran;
  p.execute = async (x) => { ran = x; return { success: true }; };
  await defs['govee-light-schedule'](saved[0]);
  assert.deepEqual(ran, { color: 'bright white', action: 'color', device: 'C1' });
});

test('the model\'s schedule shape (time + action + value) is saved too, and can be listed and deleted', async () => {
  const { p, saved } = rig();
  const r = await p.execute({ action: 'schedules', operation: 'create', device: 'toilet', time: '7:00 AM', deviceAction: 'brightness', value: 40, repeat: 'weekdays' });
  assert.equal(r.success, true, r.error);
  assert.equal(saved[0].attrs.repeatInterval, '0 7 * * 1-5');
  const l = await p.execute({ action: 'schedules', operation: 'list' });
  assert.equal(l.count, 1);
  const d = await p.execute({ action: 'schedules', operation: 'delete', device: 'Master Toilet' });
  assert.equal(d.success, true);
  assert.equal(saved.length, 0);
});
