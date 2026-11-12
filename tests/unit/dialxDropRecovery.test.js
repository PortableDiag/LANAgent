/**
 * A call that drops under the person is recovered every time (owner, 2026-11-11, call 141): ALICE calls them back,
 * says its end crashed and it is back, carries on from the conversation; a call-back that can't reach them is a text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DialXCalls, memoryCallStore, droppedUnderThem, callbackBrief, MAX_CALLBACKS } from '../../src/services/textx/dialx.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

function rig({ callResult = { success: true, result: 'calling' } } = {}) {
  const told = [], calls = [], texts = [];
  const agent = {
    config: { name: 'ALICE' },
    notify: async (t) => told.push(t),
    apiManager: { apis: new Map([
      ['dialx', { instance: { call: async (d) => { calls.push(d); return typeof callResult === 'function' ? callResult(d) : callResult; },
        callOwner: async (req, purpose, d) => { calls.push({ owner: true, purpose, ...d }); return { success: true }; } } }],
      ['textx', { instance: { execute: async (d) => { texts.push(d); return { success: true }; } } }]
    ]) }
  };
  const hub = { tellOwner: async (_d, t) => told.push(t), callTool: async () => ({ ok: true, result: {} }) };
  const store = memoryCallStore();
  const dx = new DialXCalls({ hub, agent, store, logger: quiet });
  dx.callbackWaitMs = 0;
  return { dx, told, calls, texts, store };
}
const device = { id: 'dev1' };
async function answeredThenEnds(r, reason, id = 'c1') {
  await r.dx.onEvent(device, { kind: 'call.started', call_id: id, contact: { name: 'Mom Smith', number: '+15550001' }, purpose: 'ask how her Wednesday is going' });
  const s = r.dx.calls.get(id); s.answeredAtMs = Date.now();
  s.transcript.push({ role: 'agent', text: 'Hi Mom, how is your Wednesday?' }, { role: 'callee', text: 'Pretty good, I fed the cats' });
  await r.dx.onEvent(device, { kind: 'call.ended', call_id: id, reason, duration_s: 36, transcript: s.transcript });
  for (let i = 0; i < 30; i++) await tick(5);
}

test('a call that DialX stopped after they answered is called back with an apology and the conversation so far', async () => {
  const r = rig();
  await answeredThenEnds(r, 'dialx_stopped');
  assert.equal(r.calls.length, 1);
  const c = r.calls[0];
  assert.equal(c.contact, 'Mom Smith');
  assert.match(c.opening, /my end crashed and the call dropped\. I'm back/);
  assert.match(c.purpose, /CALL-BACK/);
  assert.match(c.purpose, /I fed the cats/);
  assert.match(c.purpose, /ask how her Wednesday/);
  assert.ok(r.told.some(t => /calling them back now/.test(t)), 'the owner is told');
  assert.ok(!r.told.some(t => /Say if you want me to call again/.test(t)), 'no "say if you want me to call again" when it already does');
  assert.equal(r.texts.length, 0);
});

test('a call-back that cannot be placed becomes a text to them', async () => {
  const r = rig({ callResult: { success: false, error: 'No DialX phone' } });
  await answeredThenEnds(r, 'lost');
  assert.equal(r.calls.length, 1);
  assert.equal(r.texts.length, 1);
  assert.equal(r.texts[0].action, 'send');
  assert.equal(r.texts[0].to, '+15550001');
  assert.match(r.texts[0].text, /my end crashed and our call dropped/);
});

test('a call-back that is not answered becomes a text', async () => {
  const r = rig();
  await answeredThenEnds(r, 'dialx_stopped');
  (r.dx.callbacks ||= new Map()).set('c2', { contact: 'Mom Smith', number: '+15550001', first: 'Mom', self: 'ALICE', owner: 'Pat' });
  await r.dx.onEvent(device, { kind: 'call.started', call_id: 'c2', contact: { name: 'Mom Smith', number: '+15550001' }, purpose: 'x' });
  await r.dx.onEvent(device, { kind: 'call.ended', call_id: 'c2', reason: 'no_answer', duration_s: 0, transcript: [] });
  for (let i = 0; i < 20; i++) await tick(5);
  assert.equal(r.texts.length, 1);
  assert.equal(r.calls.length, 1, 'no answer is not a drop: no second call-back');
});

test(`past ${MAX_CALLBACKS} call-backs in 15 min it texts instead of calling again`, async () => {
  const r = rig();
  for (let i = 0; i <= MAX_CALLBACKS; i++) await answeredThenEnds(r, 'dialx_stopped', `c${i}`);
  assert.equal(r.calls.length, MAX_CALLBACKS);
  assert.equal(r.texts.length, 1);
});

test('normal endings, unanswered calls, voicemail and the owner\'s own calls are not call-backs', () => {
  const answered = { answeredAtMs: 1 };
  assert.equal(droppedUnderThem(answered, 'callee_hung_up'), false);
  assert.equal(droppedUnderThem(answered, 'agent_hung_up'), false);
  assert.equal(droppedUnderThem({}, 'dialx_stopped', []), false, 'never answered');
  assert.equal(droppedUnderThem({ ...answered, voicemail: true }, 'dialx_stopped'), false);
  assert.equal(droppedUnderThem({ ...answered, ownerCall: true }, 'dialx_stopped'), true, 'the owner is rung back');
  assert.equal(droppedUnderThem(answered, 'agent_silent'), true, 'DialX hanging up on a silent agent is our failure');
  assert.equal(droppedUnderThem({ ...answered, incoming: true }, 'lost'), false);
  assert.equal(droppedUnderThem({ ...answered, hangingUp: true }, 'lost'), false, 'it was already saying goodbye');
  assert.equal(droppedUnderThem(answered, 'dialx_stopped'), true);
  assert.equal(droppedUnderThem({ silentEnd: true }, 'agent_hung_up', [{ role: 'callee', text: 'hi' }]), true);
});

test('a restart mid-call calls them back too', async () => {
  const r = rig();
  await r.store.plan({ callId: 'c9', contact: 'Mom Smith', number: '+15550001', purpose: 'say hi' });
  await r.store.start({ callId: 'c9', startedAt: new Date() });
  r.dx.callBackAfterDrop = async (a, o) => { r.calls.push({ ...a, ...o }); };
  assert.equal(await r.dx.recoverInterrupted(), 1);
  assert.equal(r.calls[0].contact, 'Mom Smith');
  assert.equal(r.calls[0].why, 'a restart');
  assert.ok(r.told.some(t => /calling them back now/.test(t)));
});

test('the brief keeps only the last lines and the purpose', () => {
  const t = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'callee' : 'agent', text: `line ${i}` }));
  const b = callbackBrief({ purpose: 'p', contact: 'Mom', self: 'ALICE', why: 'dialx stopped', transcript: t });
  assert.match(b, /line 29/);
  assert.doesNotMatch(b, /line 3\b/);
});

test('the owner\'s own call that drops rings the owner back', async () => {
  const r = rig();
  assert.equal(await r.dx.callBackAfterDrop({ owner: true, contact: 'you', purpose: 'you asked me to call you', why: 'dialx stopped' }), 'called');
  assert.equal(r.calls[0].owner, true);
  assert.match(r.calls[0].purpose, /my end crashed and our call dropped/);
  assert.equal(r.texts.length, 0);
});
