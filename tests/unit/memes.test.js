// Memes: text placed and drawn on a picture; the popular templates never reach a paid caller (2026-11-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import MemesPlugin, { placements } from '../../src/api/plugins/memes.js';
import { renderMeme, defaultBoxes, namedBox } from '../../src/services/memes/render.js';
import { boxesFor, LAYOUTS } from '../../src/services/memes/templates.js';
import { actionCreditCost, ALLOWED_PLUGINS } from '../../src/api/external/routes/plugins.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const grey = () => sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer();

test('texts go top and bottom, a known template uses its own boxes, and boxes can be named or exact', () => {
  assert.deepEqual(placements({ texts: ['a', 'b'] }, { id: 'free:x' }).map(p => p.box), defaultBoxes(2));
  assert.deepEqual(placements({ top: 'a', bottom: 'b' }, null).map(p => p.text), ['a', 'b']);
  const drake = placements({ texts: ['no', 'yes'] }, { id: 'pop:181913649' });
  assert.deepEqual(drake.map(p => p.box.x), LAYOUTS[181913649].map(b => b.x));
  assert.equal(drake[0].style, 'plain');
  assert.deepEqual(placements({ boxes: [{ text: 'hi', position: 'bottom-right' }] }, null)[0].box, namedBox('bottom-right'));
  assert.deepEqual(placements({ boxes: [{ text: 'hi', x: 0.1, y: 0.2, w: 0.3, h: 0.1 }] }, null)[0].box, { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
  assert.equal(boxesFor({ id: 'pop:181913649' }, 3), null, 'more texts than the layout has: default bands');
});

test('the caption is drawn: the picture changes where the text goes and not elsewhere', async () => {
  const base = await grey();
  const out = await renderMeme(base, [{ text: 'hello world', box: { x: 0.05, y: 0.02, w: 0.9, h: 0.2 } }], { format: 'png' });
  assert.deepEqual([out.width, out.height, out.format], [640, 480, 'png']);
  const { data } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => data[(y * 640 + x) * 3];
  let changedTop = 0, changedMid = 0;
  for (let x = 0; x < 640; x += 4) { if (Math.abs(px(x, 50) - 120) > 40) changedTop++; if (Math.abs(px(x, 300) - 120) > 40) changedMid++; }
  assert.ok(changedTop > 10, `text in the top box (${changedTop})`);
  assert.equal(changedMid, 0, 'nothing drawn outside the box');
});

test('a paid caller cannot use a popular template; its own picture works and comes back as base64', async () => {
  const m = new MemesPlugin({}); m.logger = quiet;
  const refused = await m.execute({ action: 'make', template: 'pop:181913649', texts: ['a', 'b'], _caller: 'external' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /not offered through the API/);
  const own = await m.execute({ action: 'make', base64: (await grey()).toString('base64'), texts: ['top', 'bottom'], _caller: 'external' });
  assert.equal(own.success, true);
  assert.match(own.data.image, /^data:image\/jpeg;base64,/);
  assert.equal(own.data.source, 'own');
  assert.equal(own.file, undefined, 'no file path is handed to a paid caller');
});

test('memes is sold: 2 credits a meme, 1 to list or find pictures', () => {
  assert.ok(ALLOWED_PLUGINS.has('memes'));
  assert.equal(actionCreditCost('memes', 'make'), 2);
  assert.equal(actionCreditCost('memes', 'templates'), 1);
  assert.equal(actionCreditCost('memes', 'find'), 1);
});


test('unasked memes: off means no model call; on, one fitting meme goes as a photo, then waits its interval', async () => {
  const sent = [];
  let asked = 0;
  const agent = {
    providerManager: { generateResponse: async () => { asked++; return { content: '{"meme": true, "template": "own-test", "texts": ["mondays", "again"]}' }; } },
    interfaces: { get: () => ({ bot: { telegram: { sendPhoto: async (chat, photo) => sent.push({ chat, bytes: photo.source.length }) } } }) }
  };
  const m = new MemesPlugin(agent); m.logger = quiet;
  let settings = { autoMemes: false, autoMemeEveryMinutes: 60 };
  m.settings = async () => settings;
  const base = await grey();
  m.make = async (d) => ({ success: true, name: 'test', file: { path: await (async () => { const f = `/tmp/claude-meme-test-${process.pid}.jpg`; await (await import('fs/promises')).writeFile(f, base); return f; })() } });
  const at = { userText: 'ugh mondays', replyText: 'Hang in there, Monday is nearly over.', chatId: 1 };
  assert.equal(await m.autoMeme(at), null);
  assert.equal(asked, 0, 'switched off: the model is never asked');
  settings = { autoMemes: true, autoMemeEveryMinutes: 60 };
  assert.equal(await m.autoMeme({ ...at, stickerSentAt: Date.now() }), null, 'a sticker just went');
  assert.equal(await m.autoMeme(at), 'test');
  assert.equal(sent.length, 1);
  m._memeAskedAt = 0;
  assert.equal(await m.autoMeme(at), null, 'within the hour: no second meme');
  assert.equal(await m.autoMeme({ ...at, replyText: '```js\ncode\n```' }), null);
});

test('settings: switch and interval are kept within bounds', async () => {
  const { PluginSettings } = await import('../../src/models/PluginSettings.js');
  const saved = [];
  const orig = [PluginSettings.getCached, PluginSettings.setCached];
  PluginSettings.getCached = async () => null;
  PluginSettings.setCached = async (n, k, v) => saved.push(v);
  try {
    const m = new MemesPlugin({}); m.logger = quiet;
    const r = await m.execute({ action: 'settings', autoMemes: 'false', autoMemeEveryMinutes: 2 });
    assert.deepEqual(r.settings, { autoMemes: false, autoMemeEveryMinutes: 10 });
    assert.equal(saved.length, 1);
    const paid = await m.execute({ action: 'settings', autoMemes: true, _caller: 'external' });
    assert.equal(paid.success, false, 'a paid caller cannot change them');
  } finally { [PluginSettings.getCached, PluginSettings.setCached] = orig; }
});
