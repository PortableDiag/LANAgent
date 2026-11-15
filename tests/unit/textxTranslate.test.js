// TextX 0.4.92 translate_text: on the phone, nothing goes to the cloud (Trellis 2119 #458).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import TextXPlugin, { langCode } from '../../src/api/plugins/textx.js';

test('languages become ISO 639-1', () => {
  assert.equal(langCode('Spanish'), 'es');
  assert.equal(langCode('into english'), 'en');
  assert.equal(langCode('es-MX'), 'es');
  assert.equal(langCode('pt_BR'), 'pt');
  assert.equal(langCode('Klingon'), null);
});

function plugin(threadMessages, answer = { ok: true, result: { text: 'Where are you?', from: 'es', to: 'en' } }) {
  const p = Object.create(TextXPlugin.prototype);
  const calls = [];
  p.findThread = async () => ({ thread: { thread_id: 't7', title: 'Maria' } });
  p.call = async (tool, args) => { calls.push({ tool, args }); return tool === 'read_thread' ? { ok: true, result: threadMessages } : answer; };
  return { p, calls };
}

test('the latest text from the other side is translated by its id; mine and the assistant\'s are skipped', async () => {
  const { p, calls } = plugin([
    { id: 'm1', text: 'Hola', from: { name: 'Maria' }, date: '10:00' },
    { id: 'm2', text: '¿Dónde estás?', from: { name: 'Maria' }, date: '10:05' },
    { id: 'm3', text: 'On my way', from: 'me', direction: 'out' },
    { id: 'm4', text: 'This is ALICE', author: { role: 'assistant', name: 'ALICE' } }]);
  const r = await p.translate({ thread: 'Maria' });
  assert.equal(r.success, true);
  assert.deepEqual(calls[1], { tool: 'translate_text', args: { thread_id: 't7', message_id: 'm2', to: 'en' } });
  assert.equal(r.translation, 'Where are you?');
  assert.match(r.result, /Maria's last text \(10:05\), es → en/);
});

test('given text goes as text; an unknown language or a switched-off group says what to do', async () => {
  const { p, calls } = plugin([]);
  await p.translate({ text: 'see you at six', to: 'Spanish' });
  assert.deepEqual(calls[0], { tool: 'translate_text', args: { text: 'see you at six', to: 'es' } });
  assert.match((await p.translate({ text: 'x', to: 'Klingon' })).error, /don't know the language/);
  const off = plugin([], { ok: false, error: { code: 'not_allowed' } });
  assert.match((await off.p.translate({ text: 'hola' })).error, /Turn on Translate in TextX/);
});

test('translate_text is a known TextX tool (else the hub refuses it and the phone greys out its switch)', async () => {
  const { TOOLS } = await import('../../src/services/textx/textxHub.js');
  assert.ok(TOOLS.includes('translate_text'));
});
