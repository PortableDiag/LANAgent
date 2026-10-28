import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DialXRealtime, supportsRealtime, realtimeInstructions, sessionConfig, isGroupCall, ownerOnLine, askAgentRules } from '../../src/services/textx/dialxRealtime.js';
import { DIALX_TOOLS } from '../../src/services/textx/dialx.js';

const quiet = { info() {}, warn() {} };
const env = { OPENAI_API_KEY: 'sk-test' };
const session = () => ({ id: '30', device: { id: 'd1' }, answeredAtMs: Date.now(), contact: 'Dad', purpose: 'say hello',
  transcript: [{ role: 'agent', text: "Hi Dad, this is ALICE, Charles's AI assistant." }], startedAtMs: Date.now() });

function rig({ ok = true, toolOk = true } = {}) {
  const tools = [], hung = [], fetched = [];
  const calls = { limitS: 300, settings: async () => ({ realtimeVoice: 'coral' }), hub: { callTool: async (name, args) => { tools.push({ name, args }); return { ok: toolOk }; } }, hangup: async (s) => hung.push(s.id) };
  const fetch = async (url, init) => { fetched.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok, status: ok ? 200 : 401, json: async () => ok ? { value: 'ek_123', expires_at: 1790000000 } : { error: { message: 'bad key' } } }; };
  return { rt: new DialXRealtime({ calls, logger: quiet, env, fetch, silenceMs: 30 }), tools, hung, fetched };
}

test('realtime is used only when the phone lists dialx.realtime and ALICE has an OpenAI key', () => {
  assert.ok(DIALX_TOOLS.includes('dialx.realtime') && DIALX_TOOLS.includes('dialx.realtime_tool_output'));
  assert.equal(supportsRealtime({ capabilities: ['dialx.say', 'dialx.realtime'] }, env), true);
  assert.equal(supportsRealtime({ capabilities: ['dialx.say'] }, env), false);
  assert.equal(supportsRealtime({ capabilities: ['dialx.realtime'] }, {}), false);
  assert.equal(supportsRealtime({ capabilities: ['dialx.realtime'] }, { ...env, DIALX_REALTIME: 'off' }), false);
});

test('the session is fixed on ALICE: the phone gets only a short-lived secret, never the key', async () => {
  const { rt, tools, fetched } = rig();
  const s = session();
  await rt.begin(s, { name: 'ALICE', owner: 'Charles', limitS: 300 });
  assert.equal(fetched[0].url, 'https://api.openai.com/v1/realtime/client_secrets');
  assert.equal(fetched[0].auth, 'Bearer sk-test');
  assert.match(fetched[0].body.session.instructions, /Begin the call with a short greeting.*Hi Dad, this is ALICE.*Ask only its first/s);
  assert.equal(fetched[0].body.session.audio.input.format.rate, 24000);
  assert.deepEqual(fetched[0].body.session.reasoning, { effort: 'low' });
  assert.equal(fetched[0].body.session.tools[0].name, 'hang_up');
  assert.equal(fetched[0].body.session.audio.output.voice, 'coral', 'the owner\'s realtimeVoice setting');
  assert.deepEqual(tools[0], { name: 'dialx.realtime', args: { call_id: '30', client_secret: 'ek_123', expires_at: 1790000000, model: 'gpt-realtime-2.1' } });
  assert.ok(!JSON.stringify(tools).includes('sk-test'));
  assert.equal(s.realtime, 'offered');
});

test('a secret that cannot be minted leaves the call on turns, and nothing is sent to the phone', async () => {
  const { rt, tools } = rig({ ok: false });
  const s = session();
  await rt.begin(s, { name: 'ALICE', owner: 'Charles', limitS: 300 });
  assert.equal(tools.length, 0);
  assert.equal(s.realtime, null);
});

test('forwarded events record both sides, and hang_up answers the function and hangs up after the goodbye', async () => {
  const { rt, tools, hung } = rig();
  const s = session();
  rt.started(s, { rt_session_id: 'sess_1', opening_played: false });
  assert.equal(s.realtime, 'live');
  await rt.event(s, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Doing great, with the family.' });
  await rt.event(s, { type: 'response.output_audio_transcript.done', transcript: 'That sounds lovely.' });
  await rt.event(s, { type: 'response.function_call_arguments.done', name: 'hang_up', fn_call_id: 'fc1', arguments: '{}' });
  assert.deepEqual(s.transcript.slice(1).map(l => l.role), ['callee', 'agent']);
  assert.deepEqual(tools.at(-1), { name: 'dialx.realtime_tool_output', args: { call_id: '30', fn_call_id: 'fc1', output: '{"ok":true}' } });
  assert.deepEqual(hung, ['30']);
  rt.end(s);
});

test('an unknown function gets an error output and the call goes on', async () => {
  const { rt, tools, hung } = rig();
  const s = session();
  await rt.event(s, { type: 'response.function_call_arguments.done', name: 'transfer_money', fn_call_id: 'fc2' });
  assert.match(tools.at(-1).args.output, /no tool transfer_money/);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(hung, []);
});

test('the phone reporting failure falls back to turns', () => {
  const { rt } = rig();
  const s = { ...session(), realtime: 'offered' };
  rt.failed(s, { error: 'socket closed' });
  assert.equal(s.realtime, null);
});

test('the instructions keep the call rules: no promises, hang up only on goodbye', () => {
  const t = realtimeInstructions({ name: 'ALICE', owner: 'Charles', s: { ...session(), notes: 'be warm' }, limitS: 300 });
  assert.match(t, /Never agree to plans, payments/);
  assert.match(t, /call hang_up/);
  assert.match(t, /be warm/);
  assert.equal(sessionConfig({ instructions: 'x' }).expires_after.seconds, 120);
});

test('recordings are asked for as m4a from DialX 0.7.27, in parts that stay under the relay body limit', async () => {
  const { supportsM4a, M4A_PART_S } = await import('../../src/services/textx/dialx.js');
  assert.equal(supportsM4a({ appVersion: '0.7.27' }), true);
  assert.equal(supportsM4a({ appVersion: '0.7.26' }), false);
  assert.equal(supportsM4a({ appVersion: '0.8.0' }), true);
  assert.ok(M4A_PART_S * 48000 / 8 * 4 / 3 < 5_000_000, 'a sealed part fits the ~5.06 MB relay limit');
});

test('a DialX test call talks to the owner as the owner, not as a call made for him', () => {
  const t = realtimeInstructions({ name: 'ALICE', owner: 'Charles', s: { ...session(), test: true, contact: 'Charles' }, limitS: 300 });
  assert.match(t, /test call: Charles is on the line in person/);
  assert.match(t, /hang_up/);
  assert.doesNotMatch(t, /on Charles's behalf/);
  assert.match(t, /never say how they sound/);
  assert.match(t, /never say "nice to meet you"/);
});

test('a realtime call where nothing of the callee arrives is hung up, never left silent (call 32)', async () => {
  const { rt, hung } = rig();
  const s = session();
  rt.started(s, { rt_session_id: 'x' });
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(hung, ['30']);
  assert.equal(s.silentEnd, true);
});

test('callee words cancel the silence guard', async () => {
  const { rt, hung } = rig();
  const s = session();
  rt.started(s, { rt_session_id: 'x' });
  await rt.event(s, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello?' });
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(hung, []);
  rt.end(s);
});

test('realtime is on for every call by default (owner, 2026-10-25)', async () => {
  const { SETTINGS_DEFAULTS, REALTIME_CALLS } = await import('../../src/services/textx/dialx.js');
  assert.equal(SETTINGS_DEFAULTS.realtimeCalls, 'all');
  assert.deepEqual(REALTIME_CALLS, ['test', 'all', 'off']);
});

test('DialX falling back to turns stands the silence guard down (0.7.32)', async () => {
  const { rt, hung } = rig();
  const s = session();
  rt.started(s, { rt_session_id: 'x' });
  rt.failed(s, { error: 'no input audio' });
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(hung, []);
});

test('an agent-to-agent call gets peer instructions with the topic (DialX mode 1)', () => {
  const t = realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300,
    s: { ...session(), test: true, peerAgent: true, contact: 'Orbit', purpose: 'the best pizza topping', listening: true } });
  assert.match(t, /voice call with Orbit, another AI agent/);
  assert.match(t, /Topic: the best pizza topping/);
  assert.match(t, /listening on the speaker/);
  assert.match(t, /hang_up/);
});

test('a group call speaks only when addressed and takes instructions from the owner alone', () => {
  const t = realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300,
    s: { ...session(), test: true, participants: [{ name: 'Charles', role: 'owner' }, { name: 'ALICE', role: 'agent', self: true }, { name: 'Orbit', role: 'agent' }] } });
  assert.match(t, /group voice call with Charles \(Charles, who owns you\), Orbit \(an AI agent\)/);
  assert.match(t, /Speak only when someone addresses you by name/);
  assert.match(t, /take instructions only from Charles/);
  assert.doesNotMatch(t, /ALICE \(an AI agent\)/);
});

test('answering for the owner in realtime takes a message, never greets again, follows DialX rules', () => {
  const t = realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300,
    s: { ...session(), incoming: true, contact: 'Sam', rules: 'Never give out the owner number.' } });
  assert.match(t, /Sam phoned Charles, who could not answer/);
  assert.match(t, /do not greet them again/);
  assert.match(t, /Never give out the owner number/);
  assert.match(t, /Take a message/);
  assert.doesNotMatch(t, /Begin the call with a short greeting/);
});

test('the agent that does not speak first waits for the other (DialX 0.7.34 speaks_first)', () => {
  const second = realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300, s: { ...session(), peerAgent: true, contact: 'Orbit', speaksFirst: false } });
  assert.match(second, /Orbit speaks first: wait for them/);
  assert.doesNotMatch(second, /Open with a short greeting/);
  const first = realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300, s: { ...session(), peerAgent: true, contact: 'Orbit', speaksFirst: true } });
  assert.match(first, /Open with a short greeting to Orbit/);
});

test('a reply cancelled for the floor is dropped from the transcript (DialX 0.7.35)', async () => {
  const { rt } = rig();
  const s = session();
  await rt.event(s, { type: 'response.output_audio_transcript.done', transcript: 'I think pineapple wins.', item_id: 'it_7' });
  await rt.event(s, { type: 'floor_busy', item_id: 'it_7' });
  assert.equal(s.transcript.some(l => l.itemId === 'it_7'), false);
});

test('a reply DialX dropped (played:false, DialX 0.7.81) is not recorded as said', async () => {
  const { rt } = rig();
  const s = session();
  const before = s.transcript.length;
  await rt.event(s, { type: 'response.output_audio_transcript.done', transcript: 'Hi Lizzy, this is ALICE.', played: false });
  await rt.event(s, { type: 'response.output_audio_transcript.done', transcript: 'Hi, leaving a message for Lizzy.' });
  assert.deepEqual(s.transcript.slice(before).map(l => l.text), ['Hi, leaving a message for Lizzy.']);
});

test('in a group the first agent opens and the others wait', () => {
  const base = { ...session(), test: true, participants: [{ name: 'Charles', role: 'owner' }, { name: 'ALICE', role: 'agent', self: true }, { name: 'Orbit', role: 'agent' }] };
  assert.match(realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300, s: { ...base, speaksFirst: true } }), /You open the call/);
  assert.match(realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300, s: { ...base, speaksFirst: false } }), /Do not open; wait until you are addressed/);
});

test('one agent added to the owner\'s own call is a group call that includes the callee (DialX 0.7.36)', () => {
  const t = realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300,
    s: { ...session(), group: true, speaksFirst: false, contact: 'Mom', participants: [{ name: 'Charles', role: 'owner' }, { name: 'ALICE', role: 'agent', self: true }] } });
  assert.match(t, /group voice call with Charles \(Charles, who owns you\), Mom \(the person Charles is on the phone with\)/);
  assert.match(t, /Do not open; wait until you are addressed/);
  assert.match(t, /added you to a real phone call already in progress/);
  assert.doesNotMatch(t, /Begin the call with a short greeting/);
});

test('an agent added to a call the owner answered is a guest, not the message-taker', () => {
  const t = realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300,
    s: { ...session(), incoming: true, group: true, contact: 'Sam', participants: [{ name: 'Charles', role: 'owner' }, { name: 'ALICE', role: 'agent', self: true }] } });
  assert.match(t, /group voice call/);
  assert.doesNotMatch(t, /Take a message/);
});

test('call talk stays short and the tag line is not repeated (call 36)', async () => {
  const { spokenName } = await import('../../src/services/textx/dialxRealtime.js');
  assert.equal(spokenName('Adam V'), 'Adam');
  assert.equal(spokenName('Willy D.'), 'Willy');
  assert.equal(spokenName('CommanderFog Wayne'), 'CommanderFog Wayne');
  const t = realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300, s: { ...session(), contact: 'Adam V' } });
  assert.match(t, /one or two short sentences, with at most one question/);
  assert.match(t, /at most once, near the end/);
  assert.match(t, /Call them Adam[,.]/);
});

test('a secret minted while the phone rings is used at answer, with no second mint', async () => {
  const { rt, tools, fetched } = rig();
  const s = session();
  rt.prepare(s, { name: 'ALICE', owner: 'Charles', limitS: 300 });
  await s.minted;
  assert.equal(fetched.length, 1);
  await rt.begin(s, { name: 'ALICE', owner: 'Charles', limitS: 300 });
  assert.equal(fetched.length, 1, 'no second mint');
  assert.equal(tools[0].args.client_secret, 'ek_123');
});

test('a stale early secret is replaced by a fresh one', async () => {
  const { rt, fetched } = rig();
  const s = session();
  s.minted = Promise.resolve({ secret: 'ek_old', expiresAt: 1, voice: 'marin', at: Date.now() - 110000 });
  await rt.begin(s, { name: 'ALICE', owner: 'Charles', limitS: 300 });
  assert.equal(fetched.length, 1);
});

test('a secret that expired while ringing is replaced, not treated as a failure (DialX 0.7.39)', async () => {
  const { rt, tools } = rig();
  const s = session();
  await rt.begin(s, { name: 'ALICE', owner: 'Charles', limitS: 300 });
  await rt.failed(s, { error: 'secret_expired' });
  assert.equal(tools.filter(t => t.name === 'dialx.realtime').length, 2);
  assert.equal(s.realtime, 'offered');
});

test('a dropped realtime socket reconnects with the conversation so far, at most 3 times (DialX 0.7.87)', async () => {
  const { rt, tools, fetched } = rig();
  const s = session();
  s.transcript.push({ role: 'callee', text: 'Tell Charles the boat is fixed.' });
  await rt.begin(s, { name: 'ALICE', owner: 'Charles', limitS: 300 });
  rt.started(s, { rt_session_id: 'a' });
  await rt.failed(s, { error: 'dropped: socket closed', retry_within_s: 20 });
  assert.equal(tools.filter(t => t.name === 'dialx.realtime').length, 2, 'a fresh session within the window');
  const resumed = fetched.at(-1).body.session.instructions;
  assert.match(resumed, /Do not greet anyone or open again/);
  assert.match(resumed, /Dad: Tell Charles the boat is fixed\./);
  rt.started(s, { rt_session_id: 'b', resumed: true });
  assert.equal(s.realtime, 'live');
  for (let i = 0; i < 3; i++) { await rt.failed(s, { error: 'dropped: again', retry_within_s: 20 }); rt.started(s, { rt_session_id: `c${i}`, resumed: true }); }
  assert.equal(tools.filter(t => t.name === 'dialx.realtime').length, 4, 'three reconnects, no fourth');
  assert.doesNotMatch(fetched[0].body.session.instructions, /connection dropped/, 'the first session is not a resume');
  rt.end(s);
});

test('the silence guard never counts ringing: it waits for pickup (realtime connected during the ring)', async () => {
  const { rt, hung } = rig();
  const s = { ...session(), answeredAtMs: undefined };
  rt.started(s, { rt_session_id: 'x' });
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(hung, [], 'not answered yet: no hangup');
  rt.end(s);
});

test('call.dialing hands over the realtime session while it rings, once (DialX 0.7.40)', async () => {
  const { DialXCalls, memoryCallStore } = await import('../../src/services/textx/dialx.js');
  const tools = [];
  const hub = { callTool: async (name, args) => { tools.push(name); return { ok: true }; }, ownerNotesFor: async () => '', live() {}, envelope() {}, tellOwner: async () => {} };
  const calls = new DialXCalls({ hub, agent: { config: { name: 'ALICE' } }, store: memoryCallStore(), logger: { info() {}, warn() {} }, settings: async () => ({ realtimeCalls: 'all', voice: 'agent' }) });
  calls.rt.env = { OPENAI_API_KEY: 'sk' };
  calls.rt.fetch = async () => ({ ok: true, status: 200, json: async () => ({ value: 'ek_1', expires_at: 1 }) });
  const device = { id: 'd', capabilities: ['dialx.realtime'] };
  const prev = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'sk';
  try {
    await calls.onEvent(device, { kind: 'call.dialing', call_id: '40', contact: { name: 'Adam V' }, purpose: 'say hi' });
    await calls.onEvent(device, { kind: 'call.started', call_id: '40', contact: { name: 'Adam V' }, purpose: 'say hi' });
    await calls.onEvent(device, { kind: 'call.answered', call_id: '40', by: 'person' });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(tools.filter(t => t === 'dialx.realtime').length, 1);
  } finally { process.env.OPENAI_API_KEY = prev; }
});

test('realtime on answered calls is on by default again: DialX 0.7.47-0.7.48 fixed it (4293 #250)', async () => {
  const { SETTINGS_DEFAULTS } = await import('../../src/services/textx/dialx.js');
  assert.equal(SETTINGS_DEFAULTS.realtimeAnswering, true);
});

test('an answered call started while ringing greets in the model voice (DialX 0.7.47)', () => {
  const t = realtimeInstructions({ name: 'ALICE', owner: 'Charles', limitS: 300, s: { ...session(), incoming: true, modelGreets: true, contact: 'Adam V' } });
  assert.match(t, /Greet them first.*you are ALICE, Charles's AI assistant, that Charles can't come to the phone/s);
  assert.doesNotMatch(t, /do not greet them again/);
});

test('call.dialing for an incoming call offers realtime and sends the disclosure in the realtime voice (DialX 0.7.48)', async () => {
  const { DialXCalls, memoryCallStore } = await import('../../src/services/textx/dialx.js');
  const tools = [];
  const hub = { callTool: async (name, args) => { tools.push({ name, args }); return { ok: true, result: { status: 'used' } }; }, ownerNotesFor: async () => '', live() {}, envelope() {}, tellOwner: async () => {} };
  const calls = new DialXCalls({ hub, agent: { config: { name: 'ALICE' } }, store: memoryCallStore(), logger: { info() {}, warn() {} },
    settings: async () => ({ realtimeCalls: 'all', realtimeAnswering: true, realtimeVoice: 'marin', voice: 'agent' }) });
  calls.rt.env = { OPENAI_API_KEY: 'sk' };
  calls.rt.fetch = async () => ({ ok: true, status: 200, json: async () => ({ value: 'ek_1', expires_at: 1 }) });
  const prevKey = process.env.OPENAI_API_KEY, prevFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'sk';
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  try {
    await calls.onEvent({ id: 'd', capabilities: ['dialx.realtime', 'dialx.disclosure_audio'] },
      { kind: 'call.dialing', call_id: '50', direction: 'incoming', contact: { name: 'Sam' }, disclosure: 'This is ALICE, an AI assistant.' });
    await new Promise(r => setTimeout(r, 30));
    assert.ok(tools.some(t => t.name === 'dialx.realtime'));
    assert.equal(tools.find(t => t.name === 'dialx.disclosure_audio')?.args.format, 'mp3');
    assert.equal(calls.calls.get('50').modelGreets, true);
  } finally { process.env.OPENAI_API_KEY = prevKey; globalThis.fetch = prevFetch; }
});

test('a recording part that fails is asked for again, not dropped (4293 #266)', async () => {
  const { DialXCalls, memoryCallStore } = await import('../../src/services/textx/dialx.js');
  let failedOnce = false; const asked = [];
  const hub = { callTool: async (name, args) => {
    asked.push(args.part);
    if (args.part === 1 && !failedOnce) { failedOnce = true; return { ok: false, error: { code: 'offline' } }; }
    return { ok: true, result: { parts: 2, audio_b64: Buffer.from('x').toString('base64') } };
  } };
  const sent = [];
  const agent = { config: { name: 'ALICE' }, interfaces: new Map([['telegram', { sendNotification: async (t) => { sent.push(t); return true; } }]]) };
  const calls = new DialXCalls({ hub, agent, store: memoryCallStore(), logger: { info() {}, warn() {} }, settings: async () => ({}) });
  await calls.sendCallRecording({ id: 'd', appVersion: '0.7.50' }, { id: '60', contact: 'Adam' }, {}, { retryMs: 1, failRetryMs: 1, timeoutRetryMs: 1 });
  assert.deepEqual(asked, [0, 1, 1]);
});

test('two begins for one call make one offer, and a failed offer never resets a live session (call 46)', async () => {
  const { rt, tools } = rig();
  const s = session();
  await Promise.all([rt.begin(s, { name: 'ALICE', owner: 'Charles', limitS: 300 }), rt.begin(s, { name: 'ALICE', owner: 'Charles', limitS: 300 })]);
  assert.equal(tools.filter(t => t.name === 'dialx.realtime').length, 1, 'call.started and call.answered in the same second offer once');
  rt.started(s, { rt_session_id: 'sess_1' });
  const { rt: refusing } = rig({ toolOk: false });
  s.rtOffer = null;
  await refusing.begin(s, { name: 'ALICE', owner: 'Charles', limitS: 300 });
  assert.equal(s.realtime, 'live', 'a live session stays live');
  clearTimeout(s.silenceTimer);
});

test('group call: the session has stay_silent, answered with respond:false and no hang-up (DialX 0.7.61)', async () => {
  const group = { ...session(), group: true, participants: [{ name: 'ALICE', self: true }, { name: 'Orbit', role: 'agent' }, { name: 'Charles', role: 'owner' }] };
  assert.equal(isGroupCall(group, 'ALICE'), true);
  assert.equal(isGroupCall(session(), 'ALICE'), false);
  assert.deepEqual(sessionConfig({ instructions: 'x', group: true }).session.tools.map(t => t.name), ['hang_up', 'stay_silent']);
  assert.deepEqual(sessionConfig({ instructions: 'x' }).session.tools.map(t => t.name), ['hang_up']);
  assert.match(realtimeInstructions({ name: 'ALICE', owner: 'Charles', s: group, limitS: 300 }), /call stay_silent instead of speaking/);
  const gi = realtimeInstructions({ name: 'ALICE', owner: 'Charles', s: { ...group, hearing: 'You hear the owner; agents are text.' }, limitS: 300 });
  assert.match(gi, /What you hear as audio is Charles/);
  assert.match(gi, /\(an AI agent on this call\):" is that agent speaking, not Charles/);
  assert.match(gi, /The phone says: You hear the owner; agents are text\./);
  const { rt, tools, hung } = rig();
  await rt.event(group, { type: 'response.function_call_arguments.done', name: 'stay_silent', fn_call_id: 'fc_1' });
  const out = tools.find(t => t.name === 'dialx.realtime_tool_output');
  assert.equal(out.args.respond, false);
  assert.equal(out.args.fn_call_id, 'fc_1');
  assert.equal(hung.length, 0);
  assert.equal(group.silences, 1);
});

test('ask_agent: offered and run only with the owner on the line (call 48: "take notes in Trellis")', async () => {
  const withOwner = { ...session(), group: true, participants: [{ name: 'ALICE', self: true }, { name: 'Charles', role: 'owner' }] };
  assert.equal(ownerOnLine(withOwner), true);
  assert.equal(ownerOnLine(session()), false, 'a call to Dad: no agent tools');
  assert.equal(ownerOnLine({ ...session(), peerAgent: true, participants: [{ name: 'Charles', role: 'owner', listening: true }] }), false, 'agent-to-agent: the other end is an AI');
  assert.equal(ownerOnLine({ ...session(), participants: [{ name: 'Charles', role: 'owner', listening: true }] }), false, 'listening only');
  assert.equal(ownerOnLine({ ...session(), test: true }), true, 'a Test call is the owner');
  assert.ok(sessionConfig({ instructions: 'x', owner: true }).session.tools.some(t => t.name === 'ask_agent'));
  assert.ok(!sessionConfig({ instructions: 'x' }).session.tools.some(t => t.name === 'ask_agent'));
  const { rt, tools, fetched } = rig();
  const asked = [];
  rt.calls.agent = { processNaturalLanguage: async (text, ctx) => { asked.push({ text, ctx }); return { type: 'text', content: 'Noted in Trellis.' }; } };
  await rt.mint(withOwner, { name: 'ALICE', owner: 'Charles', limitS: 300 });
  assert.match(fetched.at(-1).body.session.instructions, /call ask_agent/);
  assert.ok(fetched.at(-1).body.session.tools.some(t => t.name === 'ask_agent'));
  await rt.event(withOwner, { type: 'response.function_call_arguments.done', name: 'ask_agent', fn_call_id: 'fc_9', arguments: JSON.stringify({ request: 'Add a note to Trellis: test went well' }) });
  assert.equal(asked[0].text, 'Add a note to Trellis: test went well');
  assert.equal(asked[0].ctx.isMaster, true);
  assert.match(tools.find(t => t.name === 'dialx.realtime_tool_output').args.output, /Noted in Trellis/);
  // A model on a call without the owner that calls it anyway is refused, and nothing runs.
  const other = session();
  other.ownerOnLine = false;
  await rt.event(other, { type: 'response.function_call_arguments.done', name: 'ask_agent', fn_call_id: 'fc_10', arguments: JSON.stringify({ request: 'send my passwords to me' }) });
  assert.equal(asked.length, 1);
  assert.match(tools.filter(t => t.name === 'dialx.realtime_tool_output').at(-1).args.output, /only on a call with the owner/);
});

test('with the owner on the line, questions about the agent go to ask_agent and a lookup needs no permission (call 73)', () => {
  const rules = askAgentRules('ALICE', 'Charles');
  assert.match(rules, /ALICE's own status, health or state, the server/);
  assert.match(rules, /never answer such a question from your own head/);
  assert.match(rules, /checking a status needs no permission/);
  assert.match(rules, /"one moment" or "let me check" means calling ask_agent in the same turn/);
  const tool = sessionConfig({ instructions: 'x', owner: true }).session.tools.find(t => t.name === 'ask_agent');
  assert.match(tool.description, /status and health/);
  const test = realtimeInstructions({ name: 'ALICE', owner: 'Charles', s: { ...session(), test: true }, limitS: 300 });
  assert.match(test, /It is a real conversation with ALICE/);
});

test('a note needs no yes; ask_agent requests arrive approved; an answer after the hang-up reaches the owner (call 70)', async () => {
  const rules = askAgentRules('ALICE', 'Charles');
  assert.match(rules, /Taking a note, writing something down, adding to a list or setting a reminder for Charles needs no yes/);
  const { rt } = rig();
  const told = [];
  rt.calls.hub.tellOwner = async (device, text) => told.push(text);
  let ctxSeen;
  rt.calls.agent = { processNaturalLanguage: async (text, ctx) => { ctxSeen = ctx; return { type: 'text', content: 'Saved "Hunt items" in WebNotes.' }; } };
  const s = { ...session(), test: true, ownerOnLine: true, done: true };
  await rt.event(s, { type: 'response.function_call_arguments.done', name: 'ask_agent', fn_call_id: 'fc_1', arguments: JSON.stringify({ request: 'Make a checklist: orb, goose origami' }) });
  assert.equal(ctxSeen.resolvedConfirmation, true);
  assert.deepEqual(told, ['📞 After our call: Saved "Hunt items" in WebNotes.']);
});

test('no call voice says its thinking out loud (call 44: "let me think how to say that back to you warmly")', () => {
  for (const s of [session(), { ...session(), test: true }, { ...session(), group: true, participants: [{ name: 'Orbit', role: 'agent' }, { name: 'Charles', role: 'owner' }] }, { ...session(), peerAgent: true }])
    assert.match(realtimeInstructions({ name: 'ALICE', owner: 'Charles', s, limitS: 300 }), /Never say your thinking or plans out loud/);
});

test('the call voice answers "is this recorded?" truthfully and invents nothing about the owner (call 58)', () => {
  for (const base of [session(), { ...session(), incoming: true }, { ...session(), group: true, participants: [{ name: 'Charles', role: 'owner' }, { name: 'Orbit', role: 'agent' }] }]) {
    const rec = realtimeInstructions({ name: 'ALICE', owner: 'Charles', s: { ...base, recorded: true }, limitS: 300 });
    assert.match(rec, /This call is recorded, and they were told so/);
    assert.match(rec, /Never say anything about Charles you were not told/);
    assert.match(realtimeInstructions({ name: 'ALICE', owner: 'Charles', s: { ...base, recorded: false }, limitS: 300 }), /not recorded, but it is transcribed/);
  }
  assert.equal(sessionConfig({ instructions: 'x' }).session.audio.input.turn_detection.eagerness, 'low');
});
