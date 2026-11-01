import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tellCallersFrom, realtimeInstructions } from '../../src/services/textx/dialxRealtime.js';
import { incomingPrompt } from '../../src/services/textx/dialx.js';
import { tellCallersIn } from '../../src/api/plugins/dialx.js';
import TextXPlugin from '../../src/api/plugins/textx.js';

// DialX 0.7.113 Tell callers (Trellis 4293 #532) and TextX 0.4.81 report_spam (#521).

test('tellCallersFrom reads owner_brief, then the quoted line in purpose', () => {
  assert.equal(tellCallersFrom({ owner_brief: "Tell callers who ask about me: I'm in the pool, back around 4" }), "I'm in the pool, back around 4");
  assert.equal(tellCallersFrom({ purpose: 'Take a message. If they ask about the owner, tell them what the owner asked you to say: "At the dentist"' }), 'At the dentist');
  assert.equal(tellCallersFrom({ purpose: 'Take a message.' }), '');
});

test('incoming prompts share the line and keep "never say where" otherwise', () => {
  const s = { contact: 'Bob', incoming: true, tellCallers: 'at the dentist', transcript: [] };
  for (const p of [incomingPrompt({ name: 'ALICE', owner: 'Pat', s, lines: [] }), realtimeInstructions({ name: 'ALICE', owner: 'Pat', s, limitS: 300 })]) {
    assert.match(p, /at the dentist/);
    assert.match(p, /beyond what Pat asked you to tell callers/);
  }
  const plain = realtimeInstructions({ name: 'ALICE', owner: 'Pat', s: { ...s, tellCallers: '' }, limitS: 300 });
  assert.match(plain, /Never say where Pat is or what they are doing, and never share/);
});

test('tellCallersIn parses the owner\'s phrasings', () => {
  assert.equal(tellCallersIn("tell callers I'm in the pool, back around 4"), "I'm in the pool, back around 4");
  assert.equal(tellCallersIn("If anyone calls, say I'm at the dentist until 3"), "I'm at the dentist until 3");
  assert.equal(tellCallersIn("let callers know I'm driving"), "I'm driving");
  assert.equal(tellCallersIn('call me'), null);
});

test('reportSpam sends report_spam for the thread and refuses a non-spam request', async () => {
  const p = Object.create(TextXPlugin.prototype);
  p.findThread = async () => ({ thread: { thread_id: 't9' } });
  p.confirmed = async (tool, args) => ({ tool, args });
  assert.deepEqual(await p.reportSpam({ thread: 'x', _context: { originalInput: 'report that text as spam' } }), { tool: 'report_spam', args: { thread_id: 't9' } });
  assert.equal((await p.reportSpam({ _context: { originalInput: 'delete it' } })).success, false);
  assert.equal(p.outcomeText({ status: 'reported', forwarded: true, blocked: true, deleted: false }), 'Reported as spam: sent to 7726, number blocked, conversation not deleted.');
});
