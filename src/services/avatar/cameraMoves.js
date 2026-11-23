/**
 * The camera moves the agent can film with, and the words that ask for one (the owner, 2026-11-22: "can it pan the
 * camera from left to right to get a side shot of the avatar when dancing"). bnb-camera/1; the math is lib/bnb-camera.js.
 * Left and right are the viewer's: a pan left to right starts on the viewer's left, which is the avatar's right (-yaw).
 */
const key = (t, yaw, x = {}) => ({ t, yaw, height: 0.55, distance: 2.6, look: 0.52, fov: 30, ...x });
const move = (id, title, keys, loop = false) => ({ format: 'bnb-camera/1', id, title, loop, length: { mode: 'fit_clip' }, keys });

export const CAMERA_MOVES = {
  'pan-left-right': move('pan-left-right', 'Pan left to right', [key(0, -60, { ease: 'inOut' }), key(1, 60)]),
  'pan-right-left': move('pan-right-left', 'Pan right to left', [key(0, 60, { ease: 'inOut' }), key(1, -60)]),
  'side-left': move('side-left', 'Side shot from the left', [key(0, -75)]),
  'side-right': move('side-right', 'Side shot from the right', [key(0, 75)]),
  orbit: move('orbit', 'Orbit', [key(0, 0), key(1, 360)], true),
  'push-in': move('push-in', 'Push in', [key(0, 0, { distance: 3.2, ease: 'inOut' }), key(1, 0, { distance: 2.3 })]),
  'low-hero': move('low-hero', 'Low shot', [key(0, -20, { height: 0.25, ease: 'inOut' }), key(1, 20, { height: 0.25 })]),
  crane: move('crane', 'Crane', [key(0, -15, { height: 0.3, ease: 'inOut' }), key(1, 15, { height: 1.25 })])
};

/** The camera move a request asks for, or null for the usual fixed front shot. */
export function cameraAsked(text = '') {
  const t = String(text).toLowerCase().replace(/[-_]+/g, ' ');
  const way = /\bright (?:to|towards?) (?:the )?left\b/.test(t) ? 'right-left' : /\bleft (?:to|towards?) (?:the )?right\b/.test(t) ? 'left-right' : null;
  if (/\b(?:panning|camera (?:pan|sweep)(?:s|ning|ing)?|(?:pan|sweep)(?:s|ning|ing)? (?:the |your )?(?:camera|shot|left|right|across|around|from)|(?:with a|slow) pan)\b(?! of)/.test(t) || (way && /\b(?:camera|film|shot|video)\b/.test(t))) return CAMERA_MOVES[`pan-${way || 'left-right'}`];
  if (/\b(?:orbit(?:ing)?|circl(?:e|ing) (?:around )?(?:you|yourself|it)|camera (?:go(?:es|ing)?|mov(?:es|ing)|spin(?:s|ning)?|circl(?:es|ing)) (?:all the way )?around|360 (?:shot|view|video|camera))\b/.test(t)) return CAMERA_MOVES.orbit;
  if (/\b(?:side (?:shot|view|angle)|from the (?:(left|right) )?side|in profile|profile (?:shot|view))\b/.test(t)) return CAMERA_MOVES[/\bright side\b/.test(t) ? 'side-right' : 'side-left'];
  if (/\b(?:push(?:ing)? in|zoom(?:ing)? in|camera (?:moves|moving|coming|comes) (?:in|closer))\b/.test(t)) return CAMERA_MOVES['push-in'];
  if (/\b(?:low (?:angle|shot)|hero shot)\b/.test(t)) return CAMERA_MOVES['low-hero'];
  if (/\bcrane (?:shot|move)\b/.test(t)) return CAMERA_MOVES.crane;
  return null;
}
