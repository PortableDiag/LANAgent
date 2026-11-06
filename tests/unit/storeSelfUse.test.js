// What the agent does with its store library unasked (2026-11-05): owned stickers follow a fitting reply to the owner,
// a wallpaper sits behind the dashboard, and wearing a bought model stays off unless switched on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { moodChoices, chooseSticker, stickerCouldFit, wallpaperFor } from '../../src/services/store/selfUse.js';

const sticker = (name, mood, kind = 'sticker') => ({ name, kind, mood, mime: 'image/png' });
const library = [
  { variant: 'x-stickers', files: [sticker('sticker 1.png', 'happy, sparkle'), sticker('sticker 7.png', 'sad, tears'), { name: 'preview.png', kind: 'preview' }] },
  { variant: 'bot-emoji-pack', files: [sticker('party.png', 'party', 'emoji'), sticker('party2.png', 'party', 'emoji')] }
];

test('moods come only from stickers and emoji the library holds', () => {
  const c = moodChoices(library);
  assert.deepEqual(c.map(x => x.mood), ['happy, sparkle', 'sad, tears', 'party']);
  assert.equal(c[2].picks.length, 2);
  assert.deepEqual(moodChoices([]), []);
});

test('long replies and code never get a sticker, and the model is not asked', async () => {
  assert.equal(stickerCouldFit('x'.repeat(1201)), false);
  assert.equal(stickerCouldFit('run ```ls```'), false);
  assert.equal(stickerCouldFit(''), false);
  let asked = 0;
  const r = await chooseSticker({ generate: async () => { asked++; return { content: '1' }; }, choices: moodChoices(library), userText: 'hi', replyText: 'x'.repeat(1300) });
  assert.equal(r, null);
  assert.equal(asked, 0);
});

test('the model picks a number; 0, nonsense and out of range mean no sticker', async () => {
  const choices = moodChoices(library);
  const ask = (content) => chooseSticker({ generate: async () => ({ content }), choices, userText: 'thanks!', replyText: 'Any time.' });
  assert.equal((await ask('3')).mood, 'party');
  assert.equal(await ask('0'), null);
  assert.equal(await ask('none'), null);
  assert.equal(await ask('99'), null);
});

test('a slow model means no sticker rather than a late one', async () => {
  await assert.rejects(() => chooseSticker({ generate: () => new Promise(() => {}), choices: moodChoices(library), userText: 'a', replyText: 'b', timeoutMs: 10 }), /timed out/);
});

test('wallpaper by format, changing daily; none owned is null', () => {
  const items = [{ variant: 'w', files: [
    { name: 'a.jpg', kind: 'wallpaper', format: 'desktop' }, { name: 'b.jpg', kind: 'wallpaper', format: 'desktop' }, { name: 'p.jpg', kind: 'wallpaper', format: 'phone' }] }];
  assert.equal(wallpaperFor(items, { format: 'phone' }).file.name, 'p.jpg');
  const day = 86400000;
  const names = [0, 1].map(n => wallpaperFor(items, { now: new Date(day * n) }).file.name);
  assert.deepEqual(names.sort(), ['a.jpg', 'b.jpg']);
  assert.equal(wallpaperFor([]), null);
});

async function plugin({ settings = {}, answer = '1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-self-'));
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } } }).png().toBuffer();
  for (const item of library) {
    fs.mkdirSync(path.join(dir, item.variant), { recursive: true });
    for (const f of item.files) fs.writeFileSync(path.join(dir, item.variant, f.name), png);
  }
  const sent = [];
  const asks = [];
  const agent = {
    providerManager: { generateAux: async (p) => { asks.push(p); return { content: answer }; } },
    interfaces: new Map([['telegram', { bot: { telegram: { sendSticker: async (chat, file, opts) => { sent.push({ chat, file, opts }); } } } }]])
  };
  const p = new BotsAndBorgsPlugin(agent);
  p.libraryRoot = dir;
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  p.libraryItems = async () => library;
  p.settings = async () => ({ autoUse: true, autoWear: false, ...settings });
  return { p, sent, asks };
}

test('a fitting reply gets a real sticker in the same chat, then a cooldown', async () => {
  const { p, sent, asks } = await plugin();
  assert.equal(await p.autoSticker({ userText: 'you are the best', replyText: 'Glad to help.', chatId: 5, threadId: 7 }), 'happy, sparkle');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, 5);
  assert.deepEqual(sent[0].opts, { message_thread_id: 7 });
  assert.equal((await sharp(sent[0].file.source).metadata()).format, 'webp');
  p._stickerAskedAt = 0;
  assert.equal(await p.autoSticker({ userText: 'x', replyText: 'y', chatId: 5 }), null);
  assert.equal(sent.length, 1, 'only one in the cooldown');
  assert.equal(asks.length, 1, 'and the model is not asked');
});

test('the model is asked at most once a minute when it keeps saying no', async () => {
  const { p, asks } = await plugin({ answer: '0' });
  await p.autoSticker({ userText: 'a', replyText: 'b', chatId: 5 });
  await p.autoSticker({ userText: 'a', replyText: 'b', chatId: 5 });
  assert.equal(asks.length, 1);
});

test('autoUse off: no sticker and no backdrop', async () => {
  const { p, sent, asks } = await plugin({ settings: { autoUse: false } });
  assert.equal(await p.autoSticker({ userText: 'a', replyText: 'b', chatId: 5 }), null);
  assert.equal(await p.backdrop(), null);
  assert.equal(sent.length + asks.length, 0);
});

test('backdrop finds the desktop wallpaper it owns', async () => {
  const { p } = await plugin();
  p.libraryItems = async () => [{ variant: 'walls', files: [{ name: 'd.jpg', kind: 'wallpaper', format: 'desktop', mime: 'image/jpeg' }] }];
  const b = await p.backdrop();
  assert.match(b.path, /walls[\\/]d\.jpg$/);
  assert.equal(b.mime, 'image/jpeg');
});

test('choosing a model to become skips the painted robots with no expressions', async () => {
  const { p } = await plugin();
  const products = [
    { slug: 'vrm-robot', collection: '3d-avatars', specs: [{ label: 'Face', value: 'its own painted eyes (no expression overlays)' }] },
    { slug: 'vrm-pilot', collection: '3d-avatars', specs: [{ label: 'Body', value: 'curvy' }] }
  ];
  const looked = [];
  p.agent.providerManager.analyzeImage = async () => ({ analysis: '{"what":"a pilot","score":8,"why":"fits"}' });
  p.fetchBytes = async (u) => { looked.push(u); return { buffer: Buffer.from('x') }; };
  p.api = async (_m, url) => (url === '/api/catalog' ? { products } : { product: {
    title: 'Pilot', variants: [{ id: 'vrm-pilot' }, { id: 'vrm-pilot-bundle' }], images: [{ url: 'https://x/pilot.png', caption: 'portrait' }] } });
  const pick = await p.pickFavorite({ kind: 'vrm' });
  assert.equal(pick.variant, 'vrm-pilot');
  assert.deepEqual(looked, ['https://x/pilot.png']);
});

test('asking for a bundle buys the picked model\'s bundle', async () => {
  const { p } = await plugin({ settings: { weeklyBudgetUsd: 1, requireUse: true, autoWear: true } });
  p.pickFavorite = async ({ kind }) => { assert.equal(kind, 'vrm'); return { variant: 'vrm-pilot', label: 'Pilot', why: 'fits', seen: 1 }; };
  let quoted;
  p.api = async (_m, url, o) => { if (url === '/api/quotes') { quoted = o.body.items[0].variant; return { quote: { total_cents: 1500 } }; } return {}; };
  p.ledger = async () => [];
  const r = await p.buy({ _context: { originalInput: 'buy yourself a vrm bundle from bots and borgs' } });
  assert.equal(quoted, 'vrm-pilot-bundle');
  assert.match(r.error, /costs \$15\.00/, 'stops at the budget, spending nothing');
});
