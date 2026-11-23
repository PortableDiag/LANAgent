// Moving camera for the agent's videos (bnb-camera/1, the owner 2026-11-22: "pan the camera from left to right").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveProblem, moveAt, viewFor, hiddenAt, pullFor, moveWithin } from '../../src/interfaces/web/public/lib/bnb-camera.js';
import { CAMERA_MOVES, cameraAsked } from '../../src/services/avatar/cameraMoves.js';
import { framingAsked } from '../../src/services/avatar/clipVideo.js';

test('every move of ours is a valid bnb-camera/1; bad ones are refused', () => {
  for (const m of Object.values(CAMERA_MOVES)) assert.equal(moveProblem(m), null, m.id);
  const k = CAMERA_MOVES.orbit.keys[0];
  for (const bad of [null, {}, { format: 'bnb-camera/1', keys: [] }, { format: 'bnb-camera/1', keys: [{ ...k, fov: 5 }] }, { format: 'bnb-camera/1', keys: [{ ...k, yaw: NaN }] },
    { format: 'bnb-camera/1', keys: [{ ...k, t: 0.5 }, { ...k, t: 0.5 }] }, { format: 'bnb-camera/1', keys: [{ ...k, ease: 'bounce' }, { ...k, t: 1 }] }]) assert.ok(moveProblem(bad));
});

test('a pan left to right starts on the viewer\'s left (the avatar\'s right, -X) and ends on the other side', () => {
  const p = CAMERA_MOVES['pan-left-right'];
  assert.ok(viewFor(moveAt(p, 0), 1.6).x < -1); assert.ok(viewFor(moveAt(p, 1), 1.6).x > 1);
  assert.ok(Math.abs(moveAt(p, 0.5).yaw) < 1e-9);
  const v = viewFor(moveAt(p, 0.5), 1.6); assert.ok(v.z > 4 && Math.abs(v.x) < 1e-9, 'half way it is in front (+Z)');
  assert.ok(Math.abs(Math.hypot(v.x, v.z) - 2.6 * 1.6) < 1e-9, 'distance is horizontal, in rest heights');
});

test('a set keeps the camera inside its limits; a full turn becomes one sweep with no jump', () => {
  const limits = { arc_deg: [-75, 75], distance_m: [2, 6], height_m: [0.3, 2.4] };
  const v = viewFor({ yaw: 170, height: 3, distance: 9, look: 0.5, fov: 30 }, 1.6, { limits });
  assert.equal(v.yaw, 75); assert.equal(v.distance, 6); assert.equal(v.y, 2.4);
  const swept = moveWithin(CAMERA_MOVES.orbit, limits.arc_deg);
  let last = null;
  for (let i = 0; i <= 100; i++) { const y = viewFor(moveAt(swept, i / 100), 1.6, { limits }).yaw; if (last !== null) assert.ok(Math.abs(y - last) < 6, `jump at ${i}`); last = y; }
  assert.equal(moveAt(swept, 0).yaw, -75); assert.equal(moveAt(swept, 1).yaw, 75);
  assert.equal(moveWithin(CAMERA_MOVES.orbit, null), CAMERA_MOVES.orbit);
  assert.deepEqual(moveWithin(CAMERA_MOVES['pan-right-left'], [-35, 35]).keys.map(k => k.yaw), [35, -35]);
});

test('the shot pulls back for a wide routine, and not when it already fits', () => {
  const box = (w, h) => [-w, w].flatMap(x => [0, h].flatMap(y => [-w, w].map(z => [x, y, z])));
  const p = CAMERA_MOVES['pan-left-right'];
  assert.equal(pullFor(p, 1.6, box(0.4, 1.6), 0.75), 1);
  const pull = pullFor(p, 1.6, box(1.6, 2.2), 0.75);
  assert.ok(pull > 1.2 && pull < 4, String(pull));
  assert.equal(pullFor(p, 1.6, box(1.6, 2.2), 0.75) >= pullFor(p, 1.6, box(1.6, 2.2), 16 / 9), true, 'a narrow frame needs more');
});

test('a wall is hidden only in its range, across 180 too', () => {
  assert.equal(hiddenAt([75, 145], 100), true); assert.equal(hiddenAt([75, 145], 0), false);
  assert.equal(hiddenAt([145, 215], 180), true); assert.equal(hiddenAt([145, 215], -160), true); assert.equal(hiddenAt([145, 215], 90), false);
  assert.equal(hiddenAt(null, 0), false);
});

test('the words that ask for a camera move, and the ones that do not', () => {
  const id = (t) => cameraAsked(t)?.id || null;
  assert.equal(id('send me a video of you doing the roger rabbit, pan the camera left to right'), 'pan-left-right');
  assert.equal(id('film yourself dancing and pan right to left'), 'pan-right-left');
  assert.equal(id('video of you doing the rumba with the camera panning'), 'pan-left-right');
  assert.equal(id('a video of you dancing with a side shot'), 'side-left');
  assert.equal(id('film the groove from the right side'), 'side-right');
  assert.equal(id('film yourself dancing with the camera going all the way around'), 'orbit');
  assert.equal(id('video of you waving, zoom in'), 'push-in');
  for (const t of ['send me a video of you doing the roger rabbit', 'film yourself doing the cabbage patch', 'video of you from the waist up saying hi',
    'make a video of you holding a frying pan', 'video of you with your hands on the left side of your hips', 'send Pat a video of you doing the pole dance']) assert.equal(id(t), null, t);
  assert.equal(framingAsked('pan left to right'), 'full');
});
