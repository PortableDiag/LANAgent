import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import hardhatService from '../../src/services/crypto/hardhatService.js';

test('flattenContract refuses names that could leave the project or inject arguments', async () => {
  for (const [project, contract] of [
    ['../etc', 'Token'], ['proj', '../../x'], ['proj', 'Token; rm -rf /'], ['proj', 'a b'], ['', 'Token'], ['proj', '']
  ]) {
    await assert.rejects(hardhatService.flattenContract(project, contract), (e) => e.statusCode === 400, `${project}/${contract}`);
  }
});

test('flattenContract answers 404 for a contract file that does not exist', async () => {
  const saved = hardhatService.projectsDir;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hh-flatten-'));
  try {
    hardhatService.projectsDir = dir;
    await fs.mkdir(path.join(dir, 'proj', 'contracts'), { recursive: true });
    await assert.rejects(hardhatService.flattenContract('proj', 'Missing.sol'), (e) => e.statusCode === 404 && /contracts\/Missing\.sol/.test(e.message));
  } finally {
    hardhatService.projectsDir = saved;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
