import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { UserProfile } from '../../src/services/skills/userProfile.js';

async function freshProfile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'userprofile-test-'));
  return { profile: new UserProfile({ file: path.join(dir, 'USER.md') }), dir };
}

test('restore(0) undoes the most recent change and refreshes the snapshot', async () => {
  const { profile, dir } = await freshProfile();
  try {
    await profile.add(['Likes concise answers']);
    await profile.add(['Runs a home lab with several servers']);
    assert.match(await profile.text(), /home lab/);

    const restored = await profile.restore(0);
    assert.equal(restored, '- Likes concise answers');
    assert.equal(await profile.text(), '- Likes concise answers');
    assert.equal(await profile.snapshot(), '- Likes concise answers');

    // the restore is recorded and can itself be undone
    const hist = await profile.history();
    assert.equal(hist[0].action, 'restore');
    await profile.restore(0);
    assert.match(await profile.text(), /home lab/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('restore(n) goes further back; restoring the first change empties the profile', async () => {
  const { profile, dir } = await freshProfile();
  try {
    await profile.add(['First durable fact about setup']);
    await profile.add(['Second unrelated preference here']);
    assert.equal(await profile.restore(1), '');
    assert.equal(await profile.text(), '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('restore rejects bad indexes and a missing history without writing', async () => {
  const { profile, dir } = await freshProfile();
  try {
    await assert.rejects(profile.restore(0), /history unavailable/i);
    await profile.add(['Only fact recorded so far']);
    await assert.rejects(profile.restore(1), /Available entries: 0-0/);
    await assert.rejects(profile.restore(-1), /Invalid history index/);
    await assert.rejects(profile.restore(0.5), /Invalid history index/);
    await assert.rejects(profile.restore('0'), /Invalid history index/);
    assert.equal(await profile.text(), '- Only fact recorded so far');
    // the serial chain keeps working after a rejected restore
    assert.deepEqual(await profile.add(['Another separate durable item']), ['Another separate durable item']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
