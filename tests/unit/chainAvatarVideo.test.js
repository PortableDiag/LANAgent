// "Film yourself doing X and send it to me" is one step (the agent's own 3D body, botsandborgs use as video), never a
// web search + download (2026-11-15: the planner fetched YouTube for "the phone call loop").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOneAvatarVideo } from '../../src/core/pluginChainProcessor.js';

test('a video of the agent itself is one step', () => {
  for (const t of ['film yourself doing the phone call loop and send it to me', 'send me a video of you doing your phone call loop animation',
    'Alice, send me a video of you doing the pole dance', 'record yourself waving and send it to Jo', 'make a clip of yourself drinking coffee',
    'send me a video of you saying "hi everyone"'])
    assert.equal(isOneAvatarVideo(t), true, t);
});

test('a web video, a link, or a later email is not', () => {
  for (const t of ['download the youtube video of the pole dance and send it to me', 'send me a video of cats', 'send me https://youtu.be/x',
    'film yourself waving then email it to Sam', 'find a video of a phone call animation', 'send me a video of the game'])
    assert.equal(isOneAvatarVideo(t), false, t);
});
