// DialX 0.7.137 dialx.play / dialx.stop with Bots & Borgs Call Sounds (Trellis 4293 #642).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DialXRealtime } from '../../src/services/textx/dialxRealtime.js';
import { DIALX_TOOLS, setDialXSettings, getDialXSettings } from '../../src/services/textx/dialx.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const store = {};
PluginSettings.getCached = async (_p, k) => store[k] ?? null;
PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };

function rig({ capabilities = ['dialx.play', 'dialx.stop'], owned = true } = {}) {
  const calls = [];
  const item = { variant: 'call-sounds-pack', kind: 'sound', files: [{ name: 'thinking-loop.wav', kind: 'sound' }, { name: 'hold-circuit-lounge.wav', kind: 'sound' }] };
  const plugin = { libraryItems: async () => (owned ? [item] : []), readOwned: async ({ file }) => Buffer.from(`RIFF${file.name}`) };
  const rt = new DialXRealtime({ calls: { hub: { callTool: async (name, args) => { calls.push({ name, args }); return { ok: true, result: { status: 'playing' } }; } },
    agent: { apiManager: { apis: new Map([['botsandborgs', { instance: plugin }]]) } } }, logger: quiet });
  const s = { id: 7, device: { id: 'd1', capabilities }, done: false };
  return { rt, s, calls };
}

test('play and stop are known DialX tools', () => {
  assert.ok(DIALX_TOOLS.includes('dialx.play'));
  assert.ok(DIALX_TOOLS.includes('dialx.stop'));
});

test('a call sound goes as the pack\'s WAV with loop, gain and stop rules; stop names it', async () => {
  const { rt, s, calls } = rig();
  const id = await rt.playSound(s, 'thinking-loop', { gain: 0.4, stopOn: ['callee_speaks'] });
  assert.match(id, /^thinking-loop-/);
  assert.equal(calls[0].name, 'dialx.play');
  assert.equal(calls[0].args.call_id, 7);
  assert.equal(calls[0].args.format, 'wav');
  assert.equal(calls[0].args.loop, true);
  assert.equal(calls[0].args.gain, 0.4);
  assert.deepEqual(calls[0].args.stop_on, ['callee_speaks']);
  assert.equal(Buffer.from(calls[0].args.audio_b64, 'base64').toString(), 'RIFFthinking-loop.wav');
  await rt.stopSound(s, id);
  assert.deepEqual(calls[1], { name: 'dialx.stop', args: { call_id: 7, id } });
});

test('no sound without dialx.play on the phone, without the pack, or with callSounds off', async () => {
  const a = rig({ capabilities: [] }); assert.equal(await a.rt.playSound(a.s, 'thinking-loop'), null); assert.equal(a.calls.length, 0);
  const b = rig({ owned: false }); assert.equal(await b.rt.playSound(b.s, 'thinking-loop'), null); assert.equal(b.calls.length, 0);
  await setDialXSettings({ callSounds: false });
  const c = rig(); assert.equal(await c.rt.playSound(c.s, 'thinking-loop'), null); assert.equal(c.calls.length, 0);
  await setDialXSettings({ callSounds: true });
  assert.equal((await getDialXSettings()).callSounds, true);
  await assert.rejects(setDialXSettings({ callSounds: 'yes' }), /callSounds must be true or false/);
});
