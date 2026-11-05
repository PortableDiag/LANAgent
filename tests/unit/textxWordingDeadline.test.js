import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordWithin } from '../../src/api/plugins/textx.js';

const hang = () => new Promise(() => {});
const says = (content) => async () => ({ content });
const limits = { mainMs: 20, auxMs: 20 };

test('a prompt answer comes from the main model and the fast one is never asked', async () => {
  const pm = { generateResponse: says('main'), generateAux: () => { throw new Error('not expected'); } };
  assert.equal((await wordWithin(pm, 'p', {}, limits)).content, 'main');
});

test('a hung main model falls to the fast one, with the same prompt and options', async () => {
  let got;
  const warned = [];
  const pm = { generateResponse: hang, generateAux: async (p, o) => { got = { p, o }; return { content: 'fast' }; } };
  const r = await wordWithin(pm, 'p', { maxTokens: 200 }, { ...limits, logger: { warn: (m) => warned.push(m) } });
  assert.equal(r.content, 'fast');
  assert.equal(got.p, 'p');
  assert.equal(got.o.maxTokens, 200);
  assert.match(warned[0], /no answer in 20 ms; asking the fast model/);
});

test('both hung: it throws, so the caller keeps its draft instead of waiting', async () => {
  const pm = { generateResponse: hang, generateAux: hang };
  await assert.rejects(() => wordWithin(pm, 'p', {}, limits), /no answer in 20 ms/);
});

test('a real model error is not a slow model: no second call', async () => {
  let aux = 0;
  const pm = { generateResponse: async () => { throw new Error('402 credits'); }, generateAux: async () => { aux++; return {}; } };
  await assert.rejects(() => wordWithin(pm, 'p', {}, limits), /402 credits/);
  assert.equal(aux, 0);
});

test('ownWords: an answer repeating the unquoted request goes back; quoted words never reach a model', async () => {
  const { default: TextXPlugin } = await import('../../src/api/plugins/textx.js');
  const req = 'text Pat and tell him to check telegram';
  const seq = (...a) => async () => ({ content: a.shift() });
  const make = (generateResponse, generateAux) => new TextXPlugin({ config: {}, providerManager: { generateResponse, generateAux } });

  const retried = await make(seq('Check telegram', 'Hey, can you take a look at Telegram?')).ownWords('Check Telegram', req, 'Pat');
  assert.equal(retried, 'Hey, can you take a look at Telegram?');

  const fast = await make(seq('Check telegram', 'check telegram'), async () => ({ content: 'Could you look at your Telegram?' })).ownWords('Check Telegram', req, 'Pat');
  assert.equal(fast, 'Could you look at your Telegram?');

  const greeted = await make(seq('Hey Pat, check Telegram.', 'Did you see what I sent you on Telegram?')).ownWords('Check Telegram', req, 'Pat');
  assert.equal(greeted, 'Did you see what I sent you on Telegram?');

  // The owner, 2026-11-04: an assistant passing it on. Speaking AS the owner goes back; speaking OF them is right.
  process.env.OWNER_NAME = 'Jo'; process.env.OWNER_PRONOUNS = 'she/her/her';
  const asOwner = await make(seq('Pat, I sent you something on Telegram.', 'Hey Pat, Jo sent you something on Telegram, can you take a look?')).ownWords('Check Telegram', req, 'Pat');
  assert.equal(asOwner, 'Hey Pat, Jo sent you something on Telegram, can you take a look?');
  delete process.env.OWNER_NAME; delete process.env.OWNER_PRONOUNS;

  let asked = 0;
  const quoted = await make(async () => { asked++; return { content: 'no' }; }).ownWords('check telegram', 'text Pat verbatim "check telegram"', 'Pat');
  assert.equal(quoted, 'check telegram');
  assert.equal(asked, 0);
});
