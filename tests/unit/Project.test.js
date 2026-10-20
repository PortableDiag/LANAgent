import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Project from '../../src/models/Project.js';
import '../../src/models/Task.js';

const Task = mongoose.model('Task');
const saved = { findById: Project.findById, findOneAndUpdate: Project.findOneAndUpdate, find: Project.find, count: Task.countDocuments };
afterEach(() => {
  Project.findById = saved.findById;
  Project.findOneAndUpdate = saved.findOneAndUpdate;
  Project.find = saved.find;
  Task.countDocuments = saved.count;
});

function setup({ status, tasks = 3, done }) {
  const project = { _id: 'p1', status, tasks: Array.from({ length: tasks }, (_, i) => `t${i}`) };
  const writes = [];
  Project.findById = async () => project;
  Task.countDocuments = async (q) => { assert.equal(q.completed, true); return done; };
  Project.findOneAndUpdate = async (filter, update) => {
    writes.push({ filter, update });
    return { ...project, status: update.$set.status };
  };
  return writes;
}

describe('Project.syncStatusByProgress', () => {
  it('returns null for a missing project', async () => {
    Project.findById = async () => null;
    assert.equal(await Project.syncStatusByProgress('nope'), null);
  });

  it('planning -> active once a task is done', async () => {
    const writes = setup({ status: 'planning', done: 1 });
    const r = await Project.syncStatusByProgress('p1');
    assert.equal(r.status, 'active');
    assert.deepEqual(writes[0].filter, { _id: 'p1', status: 'planning' });
  });

  it('active -> completed when every task is done', async () => {
    setup({ status: 'active', done: 3 });
    assert.equal((await Project.syncStatusByProgress('p1')).status, 'completed');
  });

  it('planning -> completed directly when every task is done', async () => {
    setup({ status: 'planning', done: 3 });
    assert.equal((await Project.syncStatusByProgress('p1')).status, 'completed');
  });

  it('never demotes active with nothing done, and never touches paused/archived/completed', async () => {
    for (const [status, done] of [['active', 0], ['paused', 3], ['archived', 3], ['completed', 3]]) {
      const writes = setup({ status, done });
      const r = await Project.syncStatusByProgress('p1');
      assert.equal(r.status, status);
      assert.equal(writes.length, 0, `${status} must not be written`);
    }
  });

  it('a project with no tasks is left alone', async () => {
    const writes = setup({ status: 'planning', tasks: 0, done: 0 });
    await Project.syncStatusByProgress('p1');
    assert.equal(writes.length, 0);
  });

  it('a concurrent status change wins (conditional write matched nothing)', async () => {
    setup({ status: 'planning', done: 1 });
    Project.findOneAndUpdate = async () => null;
    assert.equal((await Project.syncStatusByProgress('p1')).status, 'planning');
  });
});

describe('Project.syncStatusForTask', () => {
  it('syncs each project holding the task and swallows errors', async () => {
    const synced = [];
    Project.find = () => ({ select: () => ({ lean: async () => [{ _id: 'a' }, { _id: 'b' }] }) });
    const orig = Project.syncStatusByProgress;
    Project.syncStatusByProgress = async (id) => { synced.push(id); if (id === 'b') throw new Error('boom'); };
    try {
      await Project.syncStatusForTask('t1');
      assert.deepEqual(synced, ['a', 'b']);
    } finally {
      Project.syncStatusByProgress = orig;
    }
  });
});
