// One avatar, everywhere (2026-10-28): DELTA's new avatar stayed in its own folder beside the old avatar.png,
// so MindSwarm and Trellis kept the old face and Telegram was never told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { applyAgentAvatar, describeAvatarServices } from '../../src/services/avatar/applyAgentAvatar.js';
import { Agent } from '../../src/models/Agent.js';
import identity from '../../src/services/crypto/agentIdentityService.js';

async function withStubbedDisk(run, { existing = {}, history = [] } = {}) {
  const real = { writeFile: fs.writeFile, unlink: fs.unlink, mkdir: fs.mkdir, readFile: fs.readFile, readdir: fs.readdir }, realUpdate = Agent.updateOne;
  const wrote = [], removed = [], updates = [];
  fs.writeFile = async (file, buf) => { wrote.push({ file, buf }); };
  fs.unlink = async (file) => { removed.push(file); };
  fs.mkdir = async () => {};
  fs.readFile = async (file) => {
    const name = String(file).split(/[\\/]/).pop();
    if (existing[name]) return existing[name];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  fs.readdir = async () => [...history, ...wrote.filter(w => /avatar-history/.test(w.file)).map(w => String(w.file).split(/[\\/]/).pop())];
  Agent.updateOne = async (_q, u) => { updates.push(u); return {}; };
  try { return await run({ wrote, removed, updates }); } finally { Object.assign(fs, real); Agent.updateOne = realUpdate; }
}

const tinyJpeg = async () => {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).jpeg().toBuffer();
};

test('the picture being replaced is kept, in every format it was in', async () => {
  const oldPng = Buffer.from('old png'), oldJpg = Buffer.from('old jpg');
  await withStubbedDisk(async ({ wrote }) => {
    await applyAgentAvatar({}, await tinyJpeg(), { only: [] });
    const kept = wrote.filter(w => /avatar-history/.test(w.file));
    assert.equal(kept.length, 2);
    assert.ok(kept.some(w => /avatar-[^/\\]+\.png$/.test(w.file) && w.buf.equals(oldPng)));
    assert.ok(kept.some(w => /avatar-[^/\\]+\.jpg$/.test(w.file) && w.buf.equals(oldJpg)));
    assert.match(wrote[wrote.length - 1].file, /agent[\/\\]avatar\.png$/, 'the new picture is written after the copies');
  }, { existing: { 'avatar.png': oldPng, 'avatar.jpg': oldJpg } });
});

test('a first avatar, or the same picture again, adds nothing to the history', async () => {
  await withStubbedDisk(async ({ wrote }) => {
    await applyAgentAvatar({}, await tinyJpeg(), { only: [] });
    assert.equal(wrote.filter(w => /avatar-history/.test(w.file)).length, 0);
  });
  const { default: sharp } = await import('sharp');
  const same = await sharp(await tinyJpeg()).rotate().resize(1024, 1024, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer();
  await withStubbedDisk(async ({ wrote }) => {
    await applyAgentAvatar({}, await tinyJpeg(), { only: [] });
    assert.equal(wrote.filter(w => /avatar-history/.test(w.file)).length, 0);
  }, { existing: { 'avatar.png': same } });
});

test('the history keeps the newest 20', async () => {
  const history = Array.from({ length: 20 }, (_, i) => `avatar-2026-01-${String(i + 1).padStart(2, '0')}.png`);
  await withStubbedDisk(async ({ removed }) => {
    await applyAgentAvatar({}, await tinyJpeg(), { only: [] });
    const gone = removed.filter(f => /avatar-history/.test(f));
    assert.equal(gone.length, 1);
    assert.match(gone[0], /avatar-2026-01-01\.png$/, 'the oldest goes');
  }, { existing: { 'avatar.png': Buffer.from('old') }, history });
});

test('failing to keep the old picture does not stop the change', async () => {
  await withStubbedDisk(async ({ wrote }) => {
    const realWrite = fs.writeFile;
    fs.writeFile = async (file, buf) => {
      if (/avatar-history/.test(file)) throw new Error('disk full');
      return realWrite(file, buf);
    };
    await applyAgentAvatar({}, await tinyJpeg(), { only: [] });
    assert.match(wrote[0].file, /agent[\/\\]avatar\.png$/);
  }, { existing: { 'avatar.png': Buffer.from('old') } });
});

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

test('a changed picture updates the on-chain identity once; the same picture does not', async () => {
  const realUpdate = identity.updateRegistration;
  const calls = [];
  identity.updateRegistration = async (o) => { calls.push(o); return { agentId: 1, agentURI: 'ipfs://x', txHash: '0x1' }; };
  const { default: sharp } = await import('sharp');
  const agent = () => ({ agentModel: { erc8004: { agentId: 1, status: 'active' } } });
  try {
    await withStubbedDisk(async () => {
      const r = await applyAgentAvatar(agent(), await tinyJpeg(), { only: ['identity'] });
      assert.equal(r.services.identity, 'updated');
      assert.deepEqual(calls, [{ forceAvatarReupload: true }]);
    }, { existing: { 'avatar.png': Buffer.from('old') } });
    const same = await sharp(await tinyJpeg()).rotate().resize(1024, 1024, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer();
    await withStubbedDisk(async () => {
      const r = await applyAgentAvatar(agent(), await tinyJpeg(), { only: ['identity'] });
      assert.equal(r.services.identity, 'unchanged');
      assert.equal(calls.length, 1, 'no gas for a picture that did not change');
    }, { existing: { 'avatar.png': same } });
  } finally { identity.updateRegistration = realUpdate; }
});

test('an agent with no identity is not told, and a failed update is reported without stopping the change', async () => {
  const realUpdate = identity.updateRegistration;
  identity.updateRegistration = async () => { throw new Error('Pinata API keys not configured'); };
  try {
    await withStubbedDisk(async ({ wrote }) => {
      const none = await applyAgentAvatar({}, await tinyJpeg(), { only: ['identity'] });
      assert.equal(none.services.identity, 'not connected');
      const failed = await applyAgentAvatar({ agentModel: { erc8004: { agentId: 1, status: 'active' } } }, await tinyJpeg(), { only: ['identity'] });
      assert.match(failed.services.identity, /not updated: Pinata/);
      assert.match(describeAvatarServices(failed.services), /my on-chain identity not updated/);
      assert.match(wrote[wrote.length - 1].file, /avatar\.png$/);
    }, { existing: { 'avatar.png': Buffer.from('old') } });
  } finally { identity.updateRegistration = realUpdate; }
});

test('the Trellis card is republished with the new picture', async () => {
  let published = 0;
  const agent = { apiManager: { apis: new Map([['trellis-notes', { instance: { listener: { _publishCard: async () => { published++; return true; } } } }]]) } };
  await withStubbedDisk(async () => {
    const r = await applyAgentAvatar(agent, await tinyJpeg(), { only: ['trellis'] });
    assert.equal(r.services.trellis, 'updated');
    assert.equal(published, 1);
  });
});

test('an oversized picture is cut under the limit the apps accept', async () => {
  const { default: sharp } = await import('sharp');
  const { randomBytes } = await import('node:crypto');
  const raw = randomBytes(1024 * 1024 * 3);
  const noisy = await sharp(raw, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  assert.ok(noisy.length > 1500 * 1024, 'the sample really is oversized');
  await withStubbedDisk(async ({ wrote }) => {
    await applyAgentAvatar({}, noisy, { only: [] });
    const out = wrote[wrote.length - 1].buf;
    assert.ok(out.length <= 1500 * 1024, `got ${out.length}`);
    assert.equal((await sharp(out).metadata()).format, 'png');
  });
});

