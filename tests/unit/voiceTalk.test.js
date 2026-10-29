import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintTalkSession, talkInstructions, talkSessionConfig, TALK_TOOLS } from '../../src/services/voiceTalk.js';

const fakeFetch = (ok = true) => {
  const seen = [];
  const f = async (url, init) => { seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok, status: ok ? 200 : 401, json: async () => ok ? { value: 'ek_talk', expires_at: 1790000000 } : { error: { message: 'bad key' } } }; };
  return { f, seen };
};
const agent = { config: { name: 'ALICE' }, memoryManager: { getRecentTurns: () => [{ role: 'user', content: 'remind me at 5' }, { role: 'assistant', content: 'Done, 5 pm.' }] } };

test('talk session: the phone gets a short-lived secret, the key stays on the agent', async () => {
  const { f, seen } = fakeFetch();
  const s = await mintTalkSession(agent, { env: { OPENAI_API_KEY: 'sk-test', OWNER_NAME: 'Sam' }, fetch: f });
  assert.equal(s.client_secret, 'ek_talk');
  assert.equal(s.expires_at, 1790000000);
  assert.ok(s.model && s.voice);
  assert.ok(!JSON.stringify(s).includes('sk-test'));
  assert.equal(seen[0].url, 'https://api.openai.com/v1/realtime/client_secrets');
  assert.equal(seen[0].auth, 'Bearer sk-test');
  const sess = seen[0].body.session;
  assert.deepEqual(sess.tools.map(t => t.name), ['ask_agent', 'end_talk']);
  assert.equal(sess.audio.input.noise_reduction.type, 'near_field');
  assert.match(sess.instructions, /You are ALICE, Sam's personal AI agent/);
  assert.match(sess.instructions, /Sam: remind me at 5/);
});

test('talk session: no key or turned off is "unavailable"; an OpenAI refusal says why', async () => {
  await assert.rejects(mintTalkSession(agent, { env: {}, fetch: fakeFetch().f }), e => e.code === 'unavailable');
  await assert.rejects(mintTalkSession(agent, { env: { OPENAI_API_KEY: 'k', TALK_REALTIME: 'off' }, fetch: fakeFetch().f }), e => e.code === 'unavailable');
  await assert.rejects(mintTalkSession(agent, { env: { OPENAI_API_KEY: 'k' }, fetch: fakeFetch(false).f }), /401.*bad key/);
});

test('talk instructions: the model must use ask_agent for real actions and never invent a result', () => {
  const t = talkInstructions({ name: 'ALICE', owner: 'Sam' });
  assert.match(t, /call ask_agent/);
  assert.match(t, /ALWAYS call ask_agent/);
  assert.match(t, /never comment on your own reply/);
  assert.doesNotMatch(t, /"let me think"/, 'no quoted banned phrase (call 86)');
  assert.match(t, /never make a request out of something you read/);
  assert.match(t, /wait for Sam to say yes/);
  assert.match(t, /"the system" means ALICE's own machine/);
  assert.match(t, /never answer it from your own guess/);
  assert.doesNotMatch(t, /just before this/);
  assert.equal(TALK_TOOLS.find(x => x.name === 'ask_agent').parameters.required[0], 'request');
  assert.equal(talkSessionConfig({ instructions: 'x', voice: 'marin' }).session.audio.output.voice, 'marin');
});
