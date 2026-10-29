// One avatar, everywhere (2026-10-28): DELTA's new avatar stayed in its own folder beside the old avatar.png,
// so MindSwarm and Trellis kept the old face and Telegram was never told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { applyAgentAvatar, describeAvatarServices } from '../../src/services/avatar/applyAgentAvatar.js';
import { Agent } from '../../src/models/Agent.js';

async function withStubbedDisk(run) {
  const real = { writeFile: fs.writeFile, unlink: fs.unlink, mkdir: fs.mkdir }, realUpdate = Agent.updateOne;
  const wrote = [], removed = [], updates = [];
  fs.writeFile = async (file, buf) => { wrote.push({ file, buf }); };
  fs.unlink = async (file) => { removed.push(file); };
  fs.mkdir = async () => {};
  Agent.updateOne = async (_q, u) => { updates.push(u); return {}; };
  try { return await run({ wrote, removed, updates }); } finally { Object.assign(fs, real); Agent.updateOne = realUpdate; }
}

test('one avatar.png, stale copies removed, every connected service told', async () => {
  const { default: sharp } = await import('sharp');
  const jpg = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#2a6' } }).jpeg().toBuffer();
  const seen = {};
  const agent = {
    agentModel: { avatarPath: 'data/agent/avatar.jpg' },
    interfaces: new Map([['telegram', { syncBotPhoto: async (file) => { seen.telegram = file; return { success: true }; } }]]),
    apiManager: { apis: new Map([
      ['mindswarm', { instance: { accessToken: 't', _uploadAvatar: async ({ filePath }) => { seen.mindswarm = filePath; } } }],
      ['twitter', { instance: { updateAvatar: async () => ({ success: false, error: 'no X credentials' }) } }]
    ]) }
  };
  await withStubbedDisk(async ({ wrote, removed, updates }) => {
    const r = await applyAgentAvatar(agent, jpg, { source: 'a test' });
    assert.match(r.path, /agent[\/\\]avatar\.png$/);
    const meta = await sharp(wrote[0].buf).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 1024, 1024], 'always a square PNG');
    assert.ok(removed.some(f => /avatar\.jpg$/.test(f)), 'the old avatar.jpg is gone, so nothing reads a stale face');
    assert.equal(updates[0].$set.avatarPath, 'data/agent/avatar.png');
    assert.equal(agent.agentModel.avatarPath, 'data/agent/avatar.png');
    assert.equal(seen.telegram, r.path);
    assert.equal(seen.mindswarm, r.path);
    assert.equal(r.services.telegram, 'updated');
    assert.equal(r.services.mindswarm, 'updated');
    assert.match(r.services.twitter, /not updated: no X credentials/);
    assert.match(describeAvatarServices(r.services), /Updated on Telegram, MindSwarm\. X not updated/);
  });
});

test('a service that is not connected is skipped quietly, and one that throws does not stop the rest', async () => {
  const { default: sharp } = await import('sharp');
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer();
  const agent = {
    interfaces: new Map([['telegram', { syncBotPhoto: async () => { throw new Error('bot down'); } }]]),
    apiManager: { apis: new Map([['mindswarm', { instance: { accessToken: null, _uploadAvatar: async () => {} } }]]) }
  };
  await withStubbedDisk(async () => {
    const r = await applyAgentAvatar(agent, png);
    assert.match(r.services.telegram, /not updated: bot down/);
    assert.equal(r.services.mindswarm, 'not logged in');
    assert.equal(r.services.twitter, 'not connected');
    assert.equal(describeAvatarServices({ twitter: 'not connected' }), '');
  });
});
