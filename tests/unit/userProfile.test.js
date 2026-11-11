import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { UserProfile, lineDiff } from '../../src/services/skills/userProfile.js';

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

test('lineDiff reports added and removed lines, ignoring blanks and order', () => {
  assert.deepEqual(lineDiff('- a\n- b\n\n', '- b\n- c'), { added: ['- c'], removed: ['- a'] });
  assert.deepEqual(lineDiff('', '- x'), { added: ['- x'], removed: [] });
  assert.deepEqual(lineDiff(undefined, undefined), { added: [], removed: [] });
});

test('diff compares the states before history entries; -1 is the current text', async () => {
  const { profile, dir } = await freshProfile();
  try {
    await profile.add(['Likes concise answers']);
    await profile.add(['Runs a home lab with several servers']);
    await profile.set('- Runs a home lab with several servers\n- Prefers dark mode');

    // what the most recent change (the set) did
    assert.deepEqual(await profile.diff(0, -1), { added: ['- Prefers dark mode'], removed: ['- Likes concise answers'] });
    // everything since the start
    assert.deepEqual(await profile.diff(2), {
      added: ['- Runs a home lab with several servers', '- Prefers dark mode'], removed: []
    });
    await assert.rejects(profile.diff(3, -1), /Invalid history index: 3/);
    await assert.rejects(profile.diff(-1, 0), /Invalid indexA/);
    await assert.rejects(profile.diff(0, -2), /Invalid indexB/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('changes() lists each recent change with its own added/removed lines, newest first', async () => {
  const { profile, dir } = await freshProfile();
  try {
    assert.deepEqual(await profile.changes(), []);
    await profile.add(['Likes concise answers'], 'background-review');
    await profile.set('- Prefers dark mode');
    const changes = await profile.changes({ limit: 5 });
    assert.equal(changes.length, 2);
    assert.equal(changes[0].action, 'set');
    assert.deepEqual(changes[0].added, ['- Prefers dark mode']);
    assert.deepEqual(changes[0].removed, ['- Likes concise answers']);
    assert.equal(changes[1].source, 'background-review');
    assert.deepEqual(changes[1].added, ['- Likes concise answers']);
    assert.deepEqual(changes[1].removed, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
