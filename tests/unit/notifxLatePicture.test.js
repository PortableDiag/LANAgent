// Ring 3.116 posts the ding without a picture and adds the snapshot later as an `updated` event with the same title,
// text and time (NotifX 0.3.30, Trellis 3051 #210). The update must reach the owner; a second phone's copy must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotifXWatches } from '../../src/services/textx/notifx.js';

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 1)]).toString('base64');
function watches() {
  const sent = [], logs = [];
  const tg = { sendNotification: async (text, opts) => { sent.push({ text, photo: !!opts.photo }); return true; } };
  const w = new NotifXWatches({
    hub: { store: { listDevices: async () => [] } },
    agent: { interfaces: new Map([['telegram', tg]]) },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
  });
  return { w, sent, logs };
}
const ding = { package: 'com.ringapp', title: 'Front Door', text: 'Someone is at your Front Door', posted_at: 1763221345000 };
const phone = (name) => ({ id: name, name, notifxWatches: [{ watchId: 'w1', name: 'Doorbell' }] });

test('the ding, then its late snapshot as an update: both reach the owner, the second with the picture', async () => {
  const { w, sent, logs } = watches();
  await w.onEvent(phone('op15'), { kind: 'notification.posted', watch_id: 'w1', notification: ding });
  await w.onEvent(phone('op15'), { kind: 'notification.posted', watch_id: 'w1', notification: ding, updated: true, picture: { mime: 'image/jpeg', data_b64: jpeg } });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].photo, false);
  assert.equal(sent[1].photo, true);
  assert.match(logs.join('\n'), /no picture/);
  assert.match(logs.join('\n'), /picture 2 KB, updated/);
});

test('the same picture from a second phone is still a duplicate', async () => {
  const { w, sent } = watches();
  const ev = { kind: 'notification.posted', watch_id: 'w1', notification: ding, picture: { mime: 'image/jpeg', data_b64: jpeg } };
  await w.onEvent(phone('op15'), ev);
  await w.onEvent(phone('op12'), ev);
  assert.equal(sent.length, 1);
});

test('an update with no new picture after a pictured one is a duplicate', async () => {
  const { w, sent } = watches();
  await w.onEvent(phone('op15'), { kind: 'notification.posted', watch_id: 'w1', notification: ding, picture: { mime: 'image/jpeg', data_b64: jpeg } });
  await w.onEvent(phone('op15'), { kind: 'notification.posted', watch_id: 'w1', notification: ding, updated: true, picture: { mime: 'image/jpeg', data_b64: jpeg } });
  assert.equal(sent.length, 1);
});
