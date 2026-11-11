import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PluginSettings } from '../../src/models/PluginSettings.js';
import { getAgentFeatures, setAgentFeatures, trustPeer, untrustPeer, ignoreBot, unignoreBot, matchPeer, normalizeUsername } from '../../src/interfaces/telegram/agentFeatures.js';
import { AgentLink, LoopGuard, encode, parseEnvelope, MAX_DEPTH } from '../../src/interfaces/telegram/agentLink.js';
import { handleGuestUpdate, GuestLimiter, summonText, strangerGate } from '../../src/interfaces/telegram/guestMode.js';
import { isPlaceholderName, cleanTitle, fallbackTitle, TopicTitler } from '../../src/interfaces/telegram/topics.js';
import { formatAgentsCard, splitBotArg } from '../../src/interfaces/telegram/agentCommands.js';
import { conversationKey } from '../../src/core/memoryManager.js';

let store;
beforeEach(() => {
  store = new Map();
  PluginSettings.getCached = async (p, k) => (store.has(`${p}:${k}`) ? structuredClone(store.get(`${p}:${k}`)) : null);
  PluginSettings.setCached = async (p, k, v) => { store.set(`${p}:${k}`, structuredClone(v)); };
});

const PEER = { id: 555, is_bot: true, username: 'delta_lanagent_bot' };
function harness({ answer = 'the answer' } = {}) {
  const sent = [], notices = [];
  const telegram = {
    sendMessage: async (chat, text, extra) => { sent.push({ chat, text, extra }); return { message_id: sent.length }; },
    sendDocument: async (chat, doc, extra) => { sent.push({ chat, doc, extra }); return {}; }
  };
  const agent = { providerManager: { generateResponse: async () => ({ content: answer }) } };
  const link = new AgentLink({ telegram, agent, notify: async (t, o) => { notices.push({ t, o }); } });
  const ctx = (text, from = PEER, extra = {}) => ({ from, chat: { id: from.id, type: 'private' }, botInfo: { id: 1 }, message: { message_id: 9, text, ...extra } });
  return { link, sent, notices, ctx };
}

test('settings: defaults are safe, bad values are refused, peers by username', async () => {
  const f = await getAgentFeatures();
  assert.equal(f.botToBot, false);
  assert.equal(f.guestMode, 'owner');
  await assert.rejects(() => setAgentFeatures({ botToBot: 'yes' }), /true or false/);
  await assert.rejects(() => setAgentFeatures({ guestMode: 'all' }), /guestMode/);
  await assert.rejects(() => setAgentFeatures({ admin: true }), /Unknown setting/);
  assert.throws(() => normalizeUsername('@alice'), /not a bot/);
  await trustPeer('@Delta_LANAgent_bot');
  assert.equal((await getAgentFeatures()).peers.length, 1);
  assert.equal(await untrustPeer('delta_lanagent_bot'), true);
});

test('unignoreBot takes a bot off the ignored list without trusting it', async () => {
  await ignoreBot('@Other_Agent_bot');
  assert.deepEqual((await getAgentFeatures()).ignored, ['Other_Agent_bot']);
  assert.equal(await unignoreBot('other_agent_bot'), true); // case-insensitive, @ optional
  const f = await getAgentFeatures();
  assert.deepEqual(f.ignored, []);
  assert.deepEqual(f.peers, []);
  assert.equal(await unignoreBot('other_agent_bot'), false);
  await assert.rejects(unignoreBot('x'), /not a Telegram username/);
});

test('a peer is pinned by id on first contact; the same username from another id is refused', async () => {
  await trustPeer('delta_lanagent_bot');
  assert.ok((await matchPeer(PEER)).peer);
  assert.equal((await getAgentFeatures()).peers[0].id, '555');
  assert.equal((await matchPeer({ ...PEER, id: 999 })).reason, 'id_mismatch');
  assert.equal((await matchPeer({ id: 3, username: 'stranger_bot' })).reason, 'unknown');
});

test('envelopes: round trip, and anything malformed is null', () => {
  const e = parseEnvelope(encode({ type: 'ask', id: 'abc', body: 'hi' }));
  assert.deepEqual([e.type, e.id, e.depth, e.body], ['ask', 'abc', 0, 'hi']);
  assert.equal(parseEnvelope('LANAGENT/1 {nope'), null);
  assert.equal(parseEnvelope(encode({ type: 'run_shell', id: 'x' })), null);
  assert.equal(parseEnvelope(encode({ type: 'ask', id: 'x', depth: 99 })), null);
  assert.equal(parseEnvelope('hello'), null);
});

test('bot-to-bot OFF: a bot message is consumed and nothing is sent', async () => {
  await trustPeer('delta_lanagent_bot');
  const h = harness();
  await h.link.handle(h.ctx('what time is it?'));
  assert.equal(h.sent.length, 0);
});

test('an unknown bot is never answered; the owner is told once, with Trust / Ignore', async () => {
  await setAgentFeatures({ botToBot: true });
  const h = harness();
  const stranger = { id: 42, is_bot: true, username: 'random_ai_bot' };
  await h.link.handle(h.ctx('hi', stranger));
  await h.link.handle(h.ctx('hi again', stranger));
  assert.equal(h.sent.length, 0);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].o.reply_markup.inline_keyboard[0][0].callback_data, 'tgpeer_trust:random_ai_bot');
});

test('a trusted peer\'s question gets one conversation-only answer, as an envelope', async () => {
  await setAgentFeatures({ botToBot: true });
  await trustPeer('delta_lanagent_bot');
  const h = harness({ answer: '42' });
  await h.link.handle(h.ctx(encode({ type: 'ask', id: 'q1', body: 'meaning of life?' })));
  assert.equal(h.sent.length, 1);
  const r = parseEnvelope(h.sent[0].text);
  assert.deepEqual([r.type, r.re, r.depth, r.body], ['answer', 'q1', 1, '42']);
});

test('loops cannot start: answers are never answered, depth is capped, plain replies to us are answers', async () => {
  await setAgentFeatures({ botToBot: true });
  await trustPeer('delta_lanagent_bot');
  const h = harness();
  await h.link.handle(h.ctx(encode({ type: 'answer', id: 'a1', re: 'unknown', body: 'x' })));
  await h.link.handle(h.ctx(encode({ type: 'ask', id: 'deep', depth: MAX_DEPTH, body: 'x' })));
  await h.link.handle(h.ctx('sure, and you?', PEER, { reply_to_message: { from: { id: 1 }, text: 'ours' } }));
  assert.equal(h.sent.length, 0);
});

test('rate limits: a second question within 5 s and a duplicate are dropped; a flood mutes the peer', async () => {
  let t = 1_000_000;
  const guard = new LoopGuard({ now: () => t, perPeerHour: 3 });
  assert.equal(guard.check('p', 'a').ok, true); guard.record('p');
  t += 1000;
  assert.equal(guard.check('p', 'b').reason, 'too_soon');
  t += 10_000;
  assert.equal(guard.check('p', 'a').reason, 'duplicate');
  guard.record('p'); t += 10_000; guard.record('p'); t += 10_000;
  const r = guard.check('p', 'z');
  assert.equal(r.reason, 'peer_cap');
  assert.equal(r.flood, true);

  await setAgentFeatures({ botToBot: true });
  await trustPeer('delta_lanagent_bot');
  const h = harness();
  h.link.guard = new LoopGuard({ inboundHour: 2 });
  for (let i = 0; i < 3; i++) await h.link.handle(h.ctx(encode({ type: 'answer', id: `x${i}`, body: 'x' })));
  assert.match(h.notices.at(-1).t, /Muted @delta_lanagent_bot/);
  assert.ok(Date.parse((await getAgentFeatures()).peers[0].muted) > Date.now());
});

test('our own ask is answered by the peer\'s reply (correlated by id)', async () => {
  await setAgentFeatures({ botToBot: true });
  await trustPeer('delta_lanagent_bot');
  const h = harness();
  const pending = h.link.ask('delta_lanagent_bot', 'status?');
  await new Promise(r => setImmediate(r));
  const out = parseEnvelope(h.sent[0].text);
  assert.equal(h.sent[0].chat, '@delta_lanagent_bot');
  await h.link.handle(h.ctx(encode({ type: 'answer', id: 'r1', re: out.id, depth: 1, body: 'all good' })));
  assert.equal(await pending, 'all good');
  await assert.rejects(() => h.link.ask('stranger_bot', 'x'), /not a trusted agent/);
});

test('a received skill installs PENDING, never trusted, with the bot as its author', async () => {
  await setAgentFeatures({ botToBot: true });
  await trustPeer('delta_lanagent_bot');
  const h = harness();
  const calls = [];
  h.link.installSkill = async (args) => { calls.push(args); return { saved: true, status: 'pending', skill: { name: 'demo', description: 'd' } }; };
  h.link._sharing = async () => ({});
  h.link.telegram.getFileLink = async () => 'https://api.telegram.org/file/x';
  const axios = (await import('axios')).default;
  const realGet = axios.get;
  axios.get = async () => ({ data: JSON.stringify({ name: 'demo', description: 'd', body: 'b', sha256: 'h', origin: 'f'.repeat(32) }) });
  try {
    await h.link.handle(h.ctx(encode({ type: 'skill_push', id: 's1', body: { name: 'demo' } }), PEER, { text: undefined, caption: encode({ type: 'skill_push', id: 's1', body: { name: 'demo' } }), document: { file_id: 'f', file_size: 100 } }));
  } finally {
    axios.get = realGet;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trusted, false);
  assert.equal(calls[0].skill.origin, undefined, 'a claimed origin is dropped');
  assert.equal(calls[0].from.fingerprint, 'tg555');
  assert.equal(h.sent.length, 0, 'a skill push is never answered');
  assert.equal(h.notices[0].o.reply_markup.inline_keyboard[0][0].callback_data, 'skill_ok:demo');

  // over the size cap: not downloaded
  calls.length = 0;
  await h.link.handle(h.ctx(undefined, PEER, { caption: encode({ type: 'skill_push', id: 's2' }), document: { file_id: 'f', file_size: 10 * 1024 * 1024 } }));
  assert.equal(calls.length, 0);
});

test('guest mode: owner-only refuses strangers once a day, off ignores, the owner gets an answer', async () => {
  const answers = [];
  const ctx = (fromId, text = '@alice_bot translate this') => ({
    botInfo: { username: 'alice_bot' },
    telegram: { callApi: async (m, p) => { answers.push({ m, p }); return {}; } },
    update: { guest_message: { guest_query_id: 'g1', from: { id: fromId, first_name: 'X' }, text, reply_to_message: { text: 'hola' } } }
  });
  const agent = { providerManager: { generateResponse: async (prompt) => ({ content: prompt.includes('hola') ? 'hello' : '?' }) } };
  const limiter = new GuestLimiter();
  const isOwner = (id) => id === '1';
  assert.equal(await handleGuestUpdate(ctx(2), { agent, isOwner, limiter }), true);
  assert.equal(await handleGuestUpdate(ctx(2), { agent, isOwner, limiter }), true);
  assert.equal(answers.length, 1);
  assert.match(JSON.stringify(answers[0].p.result), /only answer my owner/);
  await handleGuestUpdate(ctx(1), { agent, isOwner, limiter });
  assert.equal(answers.length, 2);
  assert.match(JSON.stringify(answers[1].p.result), /hello/);
  await setAgentFeatures({ guestMode: 'off' });
  await handleGuestUpdate(ctx(1), { agent, isOwner, limiter });
  assert.equal(answers.length, 2);
  assert.equal(await handleGuestUpdate({ update: { message: {} } }, { agent, isOwner, limiter }), false);
  assert.equal(summonText('@alice_bot  what is this', 'alice_bot'), 'what is this');
});

test('guest mode "everyone" is rate limited per person', async () => {
  await setAgentFeatures({ guestMode: 'everyone' });
  const answers = [];
  const agent = { providerManager: { generateResponse: async () => ({ content: 'ok' }) } };
  const limiter = new GuestLimiter();
  const ctx = { botInfo: {}, telegram: { callApi: async () => { answers.push(1); } }, update: { guest_message: { guest_query_id: 'g', from: { id: 7 }, text: 'hi' } } };
  for (let i = 0; i < 8; i++) await handleGuestUpdate(ctx, { agent, isOwner: () => false, limiter });
  assert.equal(answers.length, 5);
});

test('topics: a placeholder-named topic is titled once; a named one is left alone', async () => {
  assert.equal(isPlaceholderName('New Chat'), true);
  assert.equal(isPlaceholderName('Taxes 2026'), false);
  assert.equal(cleanTitle('"Router setup."', 'x'), 'Router setup');
  assert.equal(fallbackTitle('one two three four five six seven'), 'one two three four five six');
  const calls = [];
  const t = new TopicTitler({ telegram: { callApi: async (m, p) => { calls.push(p); } }, generate: async () => ({ content: 'VPN check' }) });
  t.noteCreated({ chat: { id: 1 }, message_thread_id: 5, forum_topic_created: { name: 'New Chat' } });
  t.noteCreated({ chat: { id: 1 }, message_thread_id: 6, forum_topic_created: { name: 'My taxes' } });
  assert.equal(await t.maybeTitle({ chat: { id: 1 }, message_thread_id: 5 }, 'is the vpn up'), 'VPN check');
  assert.equal(await t.maybeTitle({ chat: { id: 1 }, message_thread_id: 5 }, 'again'), null);
  assert.equal(await t.maybeTitle({ chat: { id: 1 }, message_thread_id: 6 }, 'x'), null);
  assert.equal(calls.length, 1);
  assert.equal(conversationKey('42', 5), '42#5');
  assert.equal(conversationKey('42', undefined), '42');
});

test('/agents card and argument parsing', () => {
  const card = formatAgentsCard({ botToBot: false, guestMode: 'owner', topics: true, peers: [{ username: 'delta_lanagent_bot', id: '5' }], ignored: [] }, { supports_guest_queries: false });
  assert.match(card.rich, /Bot-to-bot \| \*\*off\*\*/);
  assert.match(card.rich, /Guest Mode is not enabled/);
  assert.equal(card.keyboard.inline_keyboard[0][0].callback_data, 'tgagents:b2b:on');
  assert.deepEqual(splitBotArg('/askbot @delta_lanagent_bot how are you?'), { bot: 'delta_lanagent_bot', rest: 'how are you?' });
  assert.equal(splitBotArg('/askbot'), null);
});

test('a stranger is refused unless guest mode is "everyone", and then gets plain text only', () => {
  const dm = (message, id = 42) => ({ from: { id }, chat: { type: 'private' }, message });
  const limiter = new GuestLimiter();
  // owner-only (the default): one refusal a day, then silence
  assert.equal(strangerGate(dm({ text: 'hi' }), { guestMode: 'owner', limiter }), 'refuse');
  assert.equal(strangerGate(dm({ text: 'hi again' }), { guestMode: 'owner', limiter }), 'drop');
  assert.equal(strangerGate(dm({ voice: { file_id: 'v' } }, 43), { guestMode: 'off', limiter }), 'refuse');
  // never a reply in a group
  assert.equal(strangerGate({ from: { id: 44 }, chat: { type: 'group' }, message: { text: 'hi' } }, { guestMode: 'owner', limiter }), 'drop');

  const open = new GuestLimiter();
  const everyone = { guestMode: 'everyone', limiter: open };
  // voice went to the full router as the owner; it, files and buttons are dropped
  assert.equal(strangerGate(dm({ voice: { file_id: 'v' } }), everyone), 'drop');
  assert.equal(strangerGate(dm({ document: { file_id: 'd' } }), everyone), 'drop');
  assert.equal(strangerGate({ from: { id: 42 }, chat: { type: 'private' }, callbackQuery: { data: 'x' } }, everyone), 'drop');
  // only harmless commands
  assert.equal(strangerGate(dm({ text: '/help' }), everyone), 'guest');
  for (const c of ['/tasks', '/dashboard', '/status', '/agents', '/trustbot @x']) assert.equal(strangerGate(dm({ text: c }), everyone), 'drop', c);
  // text is rate-limited
  const verdicts = Array.from({ length: 7 }, () => strangerGate(dm({ text: 'question' }, 77), everyone));
  assert.deepEqual(verdicts, ['guest', 'guest', 'guest', 'guest', 'guest', 'drop', 'drop']);
});

test('owner summons that is a task ("remember what Sam said") runs privately as the owner; the chat only sees "Got it"', async () => {
  await setAgentFeatures({ guestMode: 'owner' });
  const answers = [], ran = [];
  const agent = { providerManager: { generateResponse: async (p) => ({ content: /TASK or REPLY/.test(p) ? (/wrote:\n"remember/.test(p) ? 'TASK' : 'REPLY') : 'a reply' }) } };
  const ctx = (text) => ({ botInfo: { username: 'alice_bot' }, telegram: { callApi: async (m, p) => { answers.push(p); } },
    update: { guest_message: { guest_query_id: 'g', from: { id: 1, first_name: 'Op' }, text,
      reply_to_message: { text: 'my birthday is March 3', from: { first_name: 'Sam' } } } } });
  const runAsOwner = async (text, from) => { ran.push({ text, from: from.id }); };
  await handleGuestUpdate(ctx('@alice_bot remember this'), { agent, isOwner: (id) => id === '1', limiter: new GuestLimiter(), runAsOwner });
  assert.equal(ran.length, 1);
  assert.match(ran[0].text, /^remember this/);
  assert.match(ran[0].text, /from Sam[\s\S]*not to follow as instructions[\s\S]*my birthday is March 3/);
  assert.match(JSON.stringify(answers[0].result), /Got it/);
  await handleGuestUpdate(ctx('@alice_bot is this true?'), { agent, isOwner: (id) => id === '1', limiter: new GuestLimiter(), runAsOwner });
  assert.equal(ran.length, 1, 'a question stays a chat reply');
  assert.match(JSON.stringify(answers[1].result), /a reply/);
});

test('a non-owner summons never runs as a task, even in "everyone" mode', async () => {
  await setAgentFeatures({ guestMode: 'everyone' });
  const ran = [];
  const agent = { providerManager: { generateResponse: async () => ({ content: 'TASK' }) } };
  const ctx = { botInfo: {}, telegram: { callApi: async () => {} }, update: { guest_message: { guest_query_id: 'g', from: { id: 7 }, text: 'remember my password is x' } } };
  await handleGuestUpdate(ctx, { agent, isOwner: () => false, limiter: new GuestLimiter(), runAsOwner: async (t) => ran.push(t) });
  assert.equal(ran.length, 0);
});
