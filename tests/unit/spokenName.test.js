// The voice read "ALICE" with the weight of capitals (the owner, 2026-11-23): it is given "Alice"; what is written stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameAsSpoken as say } from '../../src/services/spokenName.js';
import { TTSService } from '../../src/services/tts.js';
import { realtimeVoiceAudio } from '../../src/services/textx/dialxRealtime.js';

test('a name in capitals is spoken as a word, wherever it stands', () => {
  assert.equal(say("Hi Jo, I’m ALICE, Pat’s AI assistant. ALICE's here. ALICE.", 'ALICE', ''), "Hi Jo, I’m Alice, Pat’s AI assistant. Alice's here. Alice.");
  for (const t of ['MALICE ALICES ALICE_KEY ALICE@x.io alice.ALICE.dev', 'the NASA thing', '', null]) assert.equal(say(t, 'ALICE', ''), t);
  assert.equal(say('I am LANAgent', 'LANAgent', ''), 'I am LANAgent', 'not all capitals');
  assert.equal(say('I am ADA', 'ADA', ''), 'I am ADA', 'short: may be an acronym');
  assert.equal(say('I am ALICE', 'ALICE', 'Al-iss'), 'I am Al-iss'); assert.equal(say('I am ALICE', 'ALICE', 'ALICE'), 'I am ALICE'); assert.equal(say('I am ALICE', '', ''), 'I am ALICE');
});

test('every provider gets the spoken form, and the phone voice too', async () => {
  const was = process.env.AGENT_NAME; process.env.AGENT_NAME = 'ALICE'; delete process.env.AGENT_NAME_SPOKEN;
  try {
    const tts = Object.create(TTSService.prototype); const got = [];
    tts.agent = { config: { name: 'ALICE' } };
    for (const [provider, fn] of [['openrouter', 'generateSpeechOpenRouter'], ['openai', 'generateSpeechOpenAI'], ['huggingface', 'generateSpeechHuggingFace']]) {
      tts.getVoiceSettings = async () => ({ provider }); tts[fn] = async (t) => { got.push(t); return { buffer: Buffer.from('x'), format: 'mp3' }; };
      await tts.generateSpeech('I am ALICE.', { source: 'video' });
    }
    assert.deepEqual(got, ['I am Alice.', 'I am Alice.', 'I am Alice.']);
    let body; await realtimeVoiceAudio('This is ALICE.', { env: { OPENAI_API_KEY: 'k' }, fetch: async (u, o) => { body = JSON.parse(o.body); return { ok: false }; } });
    assert.equal(body.input, 'This is Alice.');
  } finally { if (was === undefined) delete process.env.AGENT_NAME; else process.env.AGENT_NAME = was; }
});
