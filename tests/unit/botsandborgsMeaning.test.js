// "Use the party whistleblower thing" (the owner, 2026-11-23): the move is found by meaning over the list as it is now, so a
// new pack needs no new words in the code. Exact names and plain gestures never wait for a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

function rig(answer) {
  PluginSettings.getCached = async () => null; PluginSettings.setCached = async () => {};
  const p = new BotsAndBorgsPlugin({ interfaces: new Map(), agentModel: { activeVRMModel: 'store-vrm-racer-red' } });
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  p.vrmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mean-')); fs.mkdirSync(path.join(p.vrmRoot, 'animations'));
  fs.writeFileSync(path.join(p.vrmRoot, 'animations', 'store.json'), JSON.stringify([{ file: 'store/vrm-props-pack-4/party-horn-toot.vrma', label: 'Party Horn Toot', props: [{ prop: 'party_horn' }] }]));
  const f = (name, label, tags, x = {}) => ({ kind: 'animation', name, label, tags, ...x });
  const files = [f('party-woo.vrma', 'Party Woo', ['party', 'celebrate']), f('party-horn-toot.vrma', 'Party Horn Toot', ['party', 'horn']), f('wave.vrma', 'Wave', ['greet'], { gesture: 'wave' }),
    f('talk-loop-2.vrma', 'Talk Loop 2', ['talk'], { whileTalking: true, loop: true, seconds: 14 }), f('talk-accent.vrma', 'Talk Accent Lift', ['talk'], { whileTalking: true, seconds: 1.6 }), f('rumba.vrma', 'Rumba', ['dance'], { gesture: 'dance' })];
  p.libraryItems = async () => [{ variant: 'vrm-props-pack-4', title: 'Party', files }];
  p.wornBody = async () => 'female'; p.bodyOf = async () => 'female'; p.unsupportedProps = async () => new Map(); p.requiredProps = async () => new Map(); p.storeOffer = async () => '';
  const asked = [];
  p.agent.providerManager = { getCurrentProvider: async () => ({}), providerNameOf: () => 'openrouter', generateResponse: async (q, o) => { asked.push({ q, o }); if (answer instanceof Error) throw answer; return { content: String(answer) }; } };
  return { p, asked, files };
}

test('own words find the move, with the live list and its props in the question', async () => {
  const { p, asked, files } = rig(2);
  const r = await p.chooseClip({ asked: 'send me a video of you with the party whistleblower thing and', speaking: true });
  assert.equal(r.choice.file.label, 'Party Horn Toot');
  assert.match(asked[0].q, /2\. Party Horn Toot \[with party horn\]: party, horn/); assert.equal(asked[0].o.noReasoning, true);
  await p.chooseClip({ asked: 'send me a video of you with the party whistleblower thing and', speaking: true }); assert.equal(asked.length, 1, 'the same request is asked once');
  files.push({ kind: 'animation', name: 'kazoo.vrma', label: 'Kazoo Hum', tags: ['kazoo'] });
  await p.chooseClip({ asked: 'play the buzzing toy' }); assert.match(asked.at(-1).q, /7\. Kazoo Hum: kazoo/, 'a pack that just arrived is in it');
});

test('an exact name, a wave and a plain dance never wait for a model', async () => {
  const { p, asked } = rig(1);
  assert.equal((await p.chooseClip({ asked: 'do the party horn toot' })).choice.file.label, 'Party Horn Toot');
  assert.equal((await p.chooseClip({ asked: 'send me a video of you waving and' })).choice.file.label, 'Wave');
  assert.equal((await p.chooseClip({ asked: 'dance for me' })).choice.file.label, 'Rumba');
  assert.equal((await p.chooseClip({ asked: 'Send Jo a video message', speaking: true })).choice.file.label, 'Talk Loop 2');
  assert.equal(asked.length, 0);
});

test('a move it does not have is said, not swapped for a random one; under speech it talks', async () => {
  const { p } = rig(-1);
  assert.match((await p.chooseClip({ asked: 'do a backflip' })).error, /^I have no move for that yet/);
  assert.equal((await p.chooseClip({ asked: 'video of you doing a backflip', speaking: true })).choice.file.label, 'Talk Loop 2');
});

test('a silent or odd answer falls back to the tags', async () => {
  for (const a of [new Error('down'), 'hm', '99', '']) {
    const { p } = rig(a);
    assert.ok(['Party Woo', 'Party Horn Toot'].includes((await p.chooseClip({ asked: 'do something for the party' })).choice.file.label), String(a));
  }
});
