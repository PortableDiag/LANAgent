// The owner, 2026-11-23: "Send Jo a video message saying…" became a new custom animation and a TEXT. A video of the agent
// itself is one action, read with no model in the way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOneAvatarVideo, isVideoMessage, isTextRequest } from '../../src/core/pluginChainProcessor.js';
import { moveWords, videoRecipient } from '../../src/api/plugins/botsandborgs.js';

const YES = [
  "Send Jo a video message saying how you're sorry I missed her call last night and that one of us will call her today.",
  'Send me a video of you in your assistant avatar waving and saying hello', 'Sent me a video of you doing the cabbage patch while saying "Hi Ho silver, Pat is a goober"',
  'Alice, send Jo a video message', 'send a video message to Jo wishing him a happy birthday', 'record a video for Jo saying good morning', 'make me a quick video saying good night',
  'Send Jo a short video telling him dinner is at six', 'Film yourself doing the rumba', 'please send Sam a video greeting', 'can you send Jo a video apology', 'leave Jo a video note', 'Send Jo a video thanking her for the cake',
  'send me a video of yourself dancing in front of the beach', 'Text Jo a video message saying happy Monday'
];
const NO = [
  'Text Jo and tell him to check telegram for your secret video', 'send Jo the video', 'send that video to Jo', 'send me a video of a cat', 'Send Jo a video about turtles', 'download this video https://youtu.be/x and send it to Jo',
  'find me a funny video on youtube', 'Call Jo and explain the video', 'start a video call with Jo', 'Send Jo a text saying hello', 'send my video to Jo saying hi', 'What video did you send Jo?', 'send Jo a video link', 'make a video game'
];
for (const t of YES) test(`video: ${t.slice(0, 60)}`, () => assert.equal(isOneAvatarVideo(t), true));
for (const t of NO) test(`not: ${t.slice(0, 60)}`, () => assert.equal(isOneAvatarVideo(t), false));

test('who it goes to, and which words pick the move', () => {
  assert.equal(videoRecipient(YES[0]), 'Jo'); assert.equal(videoRecipient('Text Jo a video message saying happy Monday'), 'Jo');
  assert.equal(videoRecipient('send a video message to Jo wishing him a happy birthday'), 'Jo'); assert.equal(videoRecipient('make me a quick video saying good night'), 'me');
  assert.equal(videoRecipient('record a video for Jo saying good morning'), 'Jo'); assert.equal(videoRecipient('leave Jo a video note'), 'Jo');
  assert.doesNotMatch(moveWords(YES[0]), /call/);
  assert.match(moveWords(YES[1]), /waving/);
  assert.match(moveWords(YES[2]), /cabbage patch/); assert.doesNotMatch(moveWords(YES[2]), /silver/);
  assert.match(moveWords('a video of you saying hello while waving'), /waving/); assert.match(moveWords('video of you saying hi in front of the beach'), /beach/);
  assert.equal(moveWords('do the rumba'), 'do the rumba'); assert.equal(isVideoMessage('send Jo the video'), false); assert.equal(isTextRequest('Text Jo and tell him'), true);
});

test('"one of us" is never "one of you", and "you\'re sorry" is the agent\'s own', async () => {
  const { default: B, videoPerspective } = await import('../../src/api/plugins/botsandborgs.js');
  assert.match(videoPerspective('ALICE', 'Pat'), /"I'm sorry Pat missed your call\. One of us will call you\."/);
  const p = new B({ interfaces: new Map() }); p.logger = { info() {}, warn() {} };
  p.agent.providerManager = { generateResponse: async () => ({ content: "Hi Jo, this is ALICE, Pat's AI assistant. I'm sorry Pat missed your call last night. One of you will call you today." }) };
  assert.equal(await p.voiceLine(YES[0], 'Jo'), "Hi Jo, this is ALICE, Pat's AI assistant. I'm sorry Pat missed your call last night. One of us will call you today.");
});

test('the AI classifier answers it before any model, and only with the store plugin there', async () => {
  const { AIIntentDetector } = await import('../../src/core/aiIntentDetector.js');
  let asked = 0;
  const d = new AIIntentDetector({ apiManager: { apis: new Map(), getPlugin: (n) => (n === 'botsandborgs' ? {} : null) }, providerManager: { generateResponse: async () => { asked++; return { content: '' }; } } });
  const r = await d.detect(YES[0]);
  assert.equal(r.plugin, 'botsandborgs'); assert.equal(r.action, 'use'); assert.equal(r.parameters.as, 'video'); assert.equal(asked, 0);
  const { avatarVideoIntent } = await import('../../src/core/pluginChainProcessor.js');
  assert.equal(avatarVideoIntent(YES[0], { store: false }), null); assert.equal(avatarVideoIntent(NO[0]), null);
});

// The owner's evening of 2026-11-23: "Welcome back to Springfield" looked for a contact called Springfield; "asking, can you do the
// roger rabbit" was filmed silent.
test('whom a video is for is read from the asking, not from what is said', async () => {
  const { videoRecipient: who, asksForWords, moveWords, spokenQuote } = await import('../../src/api/plugins/botsandborgs.js');
  for (const [t, to] of [['Send Jo a video message saying Welcome back to Springfield and that her garden missed her.', 'Jo'],
    ['Send a video message to Jo of you doing the roger rabbit and asking,  can you do the roger rabbit .', 'Jo'],
    ['Send Jo a video message saying she should send me her pictures', 'Jo'], ['send Jo a video saying it was nice of her to talk to me', 'Jo'],
    ['send Jo a video of you dancing to Thriller', 'Jo'], ['send me a video of you dancing to Thriller', 'me'], ['make a video of you dancing to Thriller', 'me'],
    ['make a video saying welcome back to Springfield', 'me'], ['make a video saying hello to Jo', 'Jo'], ['make a video saying happy birthday and send it to Jo', 'Jo'],
    ['film yourself doing the rumba and send it to Jo', 'Jo'], ['make a video of you saying "welcome back" to Jo', 'Jo'], ['make a video of you saying "welcome to Springfield"', 'me'],
    ['send me a video of you using the party whistleblower thing and saying "Welcome back to town"', 'me'], ['make me a quick video saying good night', 'me'],
    ['Send Jo a  video of you doing the cabbage patch while asking can you do the cabbage patch dance', 'Jo'], ['Send  Jo\na video message  saying hi', 'Jo'], ['send  me a  video of you dancing', 'me'],
    ['Send a video  message  to  Jo saying hi', 'Jo'], ['make a video saying hello  to  Jo', 'Jo'], ['make a video saying "hi"  to Jo', 'Jo'],
    ['Send Mary Ann a video message wishing her luck', 'Mary Ann'], ['make a video saying hi and send it to me', 'me'], ['send a video to jo saying hi', 'jo']]) assert.equal(who(t), to, t);
  for (const t of ['of you doing the roger rabbit and asking,  can you do the roger rabbit .', 'a video message inviting her to dinner', 'a video thanking Jo', 'a video message wishing him luck']) assert.equal(asksForWords(t), true, t);
  for (const t of ['send me a video of you dancing', 'a video of you waving at the camera']) assert.equal(asksForWords(t), false, t);
  assert.match(moveWords('a video of you doing the roger rabbit and asking, can you do the moonwalk'), /roger rabbit and$/);
  assert.equal(spokenQuote('a video of you asking "can you do this?"'), 'can you do this?');
});
