// The owner, 2026-11-20: TextX and DialX show the assistant (else public) picture, never the personal one; the picture
// chooser gets the asking device so each app can be served its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../src/services/textx/textxTransport.js';

test('the avatar address and file are chosen per device', () => {
  const asked = [];
  const hub = {};
  createTransport(hub, { filesDir: '/tmp', avatarFile: (device) => { asked.push(device?.client || null); return null; }, logger: { info() {}, warn() {}, error() {} } });
  hub.avatarUrl({ base: 'https://a', client: 'DialX' });
  hub.avatarUrl({ base: 'https://a', client: 'NotifX' });
  assert.deepEqual(asked, ['DialX', 'NotifX']);
});
