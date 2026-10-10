import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import DevelopmentPlan from '../../src/models/DevelopmentPlan.js';

describe('DevelopmentPlan.transitionStatus', () => {
  let originalFindOneAndUpdate;

  beforeEach(() => {
    originalFindOneAndUpdate = DevelopmentPlan.findOneAndUpdate;
  });

  afterEach(() => {
    DevelopmentPlan.findOneAndUpdate = originalFindOneAndUpdate;
  });

  function mockQuery(resolvedValue) {
    return {
      exec: async () => resolvedValue
    };
  }

  it('should transition from pending to in-progress', async () => {
    const itemId = 'item1';
    const updatedDoc = { _id: itemId, status: 'in-progress' };
    DevelopmentPlan.findOneAndUpdate = (filter, update, options) => {
      assert.deepStrictEqual(filter.$and, [
        { _id: itemId },
        { status: { $in: ['pending'] } }
      ]);
      assert.deepStrictEqual(update.$set, { status: 'in-progress' });
      return mockQuery(updatedDoc);
    };

    const result = await DevelopmentPlan.transitionStatus(itemId, 'in-progress');
    assert.strictEqual(result.status, 'in-progress');
  });

  it('should transition from in-progress to completed and set completedAt', async () => {
    const itemId = 'item2';
    const updatedDoc = { _id: itemId, status: 'completed', completedAt: new Date() };
    DevelopmentPlan.findOneAndUpdate = (filter, update, options) => {
      assert.deepStrictEqual(filter.$and, [
        { _id: itemId },
        { status: { $in: ['pending', 'in-progress'] } }
      ]);
      assert.ok(update.$set.completedAt instanceof Date);
      assert.strictEqual(update.$set.status, 'completed');
      return mockQuery(updatedDoc);
    };

    const result = await DevelopmentPlan.transitionStatus(itemId, 'completed');
    assert.strictEqual(result.status, 'completed');
  });

  it('should transition from completed to archived', async () => {
    const itemId = 'item3';
    const updatedDoc = { _id: itemId, status: 'archived' };
    DevelopmentPlan.findOneAndUpdate = (filter, update, options) => {
      assert.deepStrictEqual(filter.$and, [
        { _id: itemId },
        { status: { $in: ['completed'] } }
      ]);
      assert.deepStrictEqual(update.$set, { status: 'archived' });
      return mockQuery(updatedDoc);
    };

    const result = await DevelopmentPlan.transitionStatus(itemId, 'archived');
    assert.strictEqual(result.status, 'archived');
  });

  it('allows pending -> completed (the path completeItem uses)', () => {
    assert.ok(DevelopmentPlan.transitionMap.pending.includes('completed'));
  });

  it('should reject invalid transition (archived item cannot be completed again)', async () => {
    const itemId = 'item4';
    let filterSeen;
    DevelopmentPlan.findOneAndUpdate = (filter) => { filterSeen = filter; return mockQuery(null); };
    await assert.rejects(
      () => DevelopmentPlan.transitionStatus(itemId, 'completed'),
      /Transition to completed failed/
    );
    assert.ok(!filterSeen.$and[1].status.$in.includes('archived'));
    assert.ok(!filterSeen.$and[1].status.$in.includes('completed'));
  });

  it('rejects a target no status can reach (pending from archived/completed)', async () => {
    let filterSeen;
    DevelopmentPlan.findOneAndUpdate = (filter) => { filterSeen = filter; return mockQuery(null); };
    await assert.rejects(() => DevelopmentPlan.transitionStatus('x', 'pending'), /Transition to pending failed/);
    assert.deepStrictEqual(filterSeen.$and[1].status.$in, ['in-progress']);
  });

  it('execute routes updateProgress/addMilestone/transitionStatus', async () => {
    const calls = [];
    const orig = { u: DevelopmentPlan.updateProgress, a: DevelopmentPlan.addMilestone, t: DevelopmentPlan.transitionStatus };
    DevelopmentPlan.updateProgress = async (...a) => calls.push(['updateProgress', ...a]);
    DevelopmentPlan.addMilestone = async (...a) => calls.push(['addMilestone', ...a]);
    DevelopmentPlan.transitionStatus = async (...a) => calls.push(['transitionStatus', ...a]);
    try {
      await DevelopmentPlan.execute('updateProgress', { itemId: 'i', percentage: 0 });
      await DevelopmentPlan.execute('addMilestone', { itemId: 'i', milestone: { title: 'm' } });
      await DevelopmentPlan.execute('transitionStatus', { itemId: 'i', newStatus: 'archived' });
      assert.deepStrictEqual(calls, [
        ['updateProgress', 'i', 0],
        ['addMilestone', 'i', { title: 'm' }],
        ['transitionStatus', 'i', 'archived']
      ]);
    } finally {
      Object.assign(DevelopmentPlan, { updateProgress: orig.u, addMilestone: orig.a, transitionStatus: orig.t });
    }
  });

  it('should reject invalid newStatus', async () => {
    await assert.rejects(
      () => DevelopmentPlan.transitionStatus('item5', 'unknown'),
      /Invalid status: unknown/
    );
  });

  it('should throw when item not found (no matching status)', async () => {
    const itemId = 'item6';
    DevelopmentPlan.findOneAndUpdate = () => mockQuery(null);
    await assert.rejects(
      () => DevelopmentPlan.transitionStatus(itemId, 'in-progress'),
      /Transition to in-progress failed/
    );
  });
});
