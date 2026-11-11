// DialX 0.7.133 errand calls (4293 #613): a business, its menu, hold, a person; the owner taps for anything binding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DialXRealtime, realtimeInstructions, sessionConfig } from '../../src/services/textx/dialxRealtime.js';
import { DIALX_TOOLS, DIALX_CONFIRMED } from '../../src/services/textx/dialx.js';

const quiet = { info() {}, warn() {} };
const errand = { goal: 'get the domain renewal back to last year\'s price', facts: { domain: 'example.com', 'account email': 'pat@example.com' }, maxMinutes: 45, rules: 'Say you are an AI assistant when a person answers.', tools: [] };

test('the errand tools are known, and placing one or asking the owner waits on their tap', () => {
  for (const t of ['dialx.errand_call', 'dialx.press_keys', 'dialx.errand_status', 'dialx.errand_approve']) assert.ok(DIALX_TOOLS.includes(t), t);
  assert.ok(DIALX_CONFIRMED.has('dialx.errand_call') && DIALX_CONFIRMED.has('dialx.errand_approve'));
});

test('an errand session carries the goal, the facts, the phone rules, the menu tools and the 45-minute limit', () => {
  const text = realtimeInstructions({ name: 'ALICE', owner: 'Pat', s: { contact: 'Registrar', errand }, limitS: 45 * 60 });
  assert.match(text, /get the domain renewal back/);
  assert.match(text, /domain: example\.com/);
  assert.match(text, /Say you are an AI assistant when a person answers/);
  assert.match(text, /press_keys/); assert.match(text, /errand_approve/); assert.match(text, /45 minutes/);
  const names = sessionConfig({ instructions: text, errand: true }).session.tools.map(t => t.name);
  for (const n of ['press_keys', 'errand_status', 'errand_approve', 'stay_silent', 'hang_up']) assert.ok(names.includes(n), n);
  assert.ok(!sessionConfig({ instructions: 'x' }).session.tools.some(t => t.name === 'press_keys'), 'not on other calls');
});

test("the model's errand tools go to DialX and their answers come back to the model", async () => {
  const tools = [];
  const calls = { hub: { callTool: async (name, args) => { tools.push({ name, args }); return name === 'dialx.errand_approve' ? { ok: true, result: { status: 'approved' } } : { ok: true, result: { ok: true } }; } }, hangup: async () => {} };
  const rt = new DialXRealtime({ calls, logger: quiet, env: {}, fetch: async () => ({}) });
  const s = { id: '9', device: { id: 'd1', capabilities: [] }, errand, rtGen: 1, transcript: [] };
  await rt.event(s, { type: 'response.function_call_arguments.done', name: 'press_keys', fn_call_id: 'f1', arguments: '{"digits":"2, 1#x"}' });
  await rt.event(s, { type: 'response.function_call_arguments.done', name: 'errand_status', fn_call_id: 'f2', arguments: '{"status":"a person answered","alert":true}' });
  await rt.event(s, { type: 'response.function_call_arguments.done', name: 'errand_approve', fn_call_id: 'f3', arguments: '{"question":"Pay $19.99 to renew?"}' });
  assert.deepEqual(tools.map(t => t.name), ['dialx.press_keys', 'dialx.realtime_tool_output', 'dialx.errand_status', 'dialx.realtime_tool_output', 'dialx.errand_approve', 'dialx.realtime_tool_output']);
  assert.equal(tools[0].args.digits, '2,1#');
  assert.equal(tools[2].args.alert, true);
  assert.match(tools[5].args.output, /approved/);
});

test('an errand call on hold is never hung up for silence, and the first status line is sent when it goes live', async () => {
  const tools = [], hung = [];
  const calls = { hub: { callTool: async (name, args) => { tools.push(name); return { ok: true }; } }, hangup: async (s) => hung.push(s.id) };
  const rt = new DialXRealtime({ calls, logger: quiet, env: {}, fetch: async () => ({}), silenceMs: 20 });
  const s = { id: '10', device: { id: 'd1', capabilities: [] }, errand, answeredAtMs: Date.now(), transcript: [], contact: 'Registrar' };
  rt.started(s, {});
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(hung, []);
  assert.ok(tools.includes('dialx.errand_status'));
  rt.end(s);
});
