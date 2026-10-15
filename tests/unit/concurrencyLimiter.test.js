import test from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyLimiter } from '../../src/utils/concurrencyLimiter.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('cancels queued work before it starts', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 2 });
  const blocker = deferred();
  const controller = new AbortController();
  let executed = false;

  const active = limiter.run(() => blocker.promise);
  const queued = limiter.run(
    () => {
      executed = true;
      return 'unexpected';
    },
    { signal: controller.signal }
  );

  controller.abort();

  await assert.rejects(queued, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ABORT_ERR');
    return true;
  });
  assert.equal(executed, false);
  assert.equal(limiter.stats().cancelled, 1);

  blocker.resolve('done');
  await active;
  assert.equal(limiter.stats().active, 0);
  assert.equal(limiter.stats().queued, 0);
});

test('rejects queued work after its deadline without executing it', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1 });
  const blocker = deferred();
  let executed = false;

  const active = limiter.run(() => blocker.promise);
  const queued = limiter.run(
    () => {
      executed = true;
      return 'unexpected';
    },
    { queueTimeoutMs: 10 }
  );

  await assert.rejects(queued, (error) => {
    assert.equal(error.code, 'QUEUE_TIMEOUT');
    return true;
  });
  assert.equal(executed, false);
  assert.equal(limiter.stats().timedOut, 1);
  assert.equal(limiter.stats().queued, 0);

  blocker.resolve('done');
  await active;
  assert.equal(limiter.stats().active, 0);
});

test('queued work starts when the active slot is released', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1 });
  const blocker = deferred();
  let executed = false;

  const active = limiter.run(() => blocker.promise);
  const queued = limiter.run(() => {
    executed = true;
    return 'queued result';
  });

  assert.equal(limiter.stats().active, 1);
  assert.equal(limiter.stats().queued, 1);

  blocker.resolve('active result');
  assert.equal(await active, 'active result');
  assert.equal(await queued, 'queued result');
  assert.equal(executed, true);
  assert.equal(limiter.stats().active, 0);
  assert.equal(limiter.stats().queued, 0);
});

test('higher priority tasks execute before lower priority tasks when a slot frees up', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 3 });
  const blocker = deferred();
  const executionOrder = [];

  const active = limiter.run(() => blocker.promise);

  const pB = limiter.run(() => { executionOrder.push(1); return 'B'; }, { priority: 1 });
  const pC = limiter.run(() => { executionOrder.push(2); return 'C'; }, { priority: 2 });
  const pD = limiter.run(() => { executionOrder.push(0); return 'D'; }, { priority: 0 });

  assert.equal(limiter.stats().active, 1);
  assert.equal(limiter.stats().queued, 3);

  blocker.resolve();
  await active;

  await Promise.all([pB, pC, pD]);

  assert.deepEqual(executionOrder, [2, 1, 0]);
  assert.equal(limiter.stats().active, 0);
  assert.equal(limiter.stats().queued, 0);
});

test('tasks with same priority execute in insertion order', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 3 });
  const blocker = deferred();
  const executionOrder = [];

  const active = limiter.run(() => blocker.promise);

  const p1 = limiter.run(() => { executionOrder.push('first'); return 1; }, { priority: 0 });
  const p2 = limiter.run(() => { executionOrder.push('second'); return 2; }, { priority: 0 });
  const p3 = limiter.run(() => { executionOrder.push('third'); return 3; }, { priority: 0 });

  blocker.resolve();
  await active;
  await Promise.all([p1, p2, p3]);

  assert.deepEqual(executionOrder, ['first', 'second', 'third']);
});

test('cancelling a queued high-priority task removes it from the heap and does not affect order of remaining tasks', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 3 });
  const blocker = deferred();
  const executionOrder = [];
  const controller = new AbortController();

  const active = limiter.run(() => blocker.promise);

  const pA = limiter.run(() => { executionOrder.push('A'); return 'A'; }, { priority: 1 });
  const pB = limiter.run(() => { executionOrder.push('B'); return 'B'; }, { priority: 2, signal: controller.signal });
  const pC = limiter.run(() => { executionOrder.push('C'); return 'C'; }, { priority: 0 });

  controller.abort();

  await assert.rejects(pB, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ABORT_ERR');
    return true;
  });

  assert.equal(limiter.stats().cancelled, 1);
  assert.equal(limiter.stats().queued, 2);

  blocker.resolve();
  await active;
  await Promise.all([pA, pC]);

  assert.deepEqual(executionOrder, ['A', 'C']);
  assert.equal(limiter.stats().active, 0);
  assert.equal(limiter.stats().queued, 0);
});

test('timing out a queued task removes it from the heap and does not affect order of remaining tasks', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 3 });
  const blocker = deferred();
  const executionOrder = [];

  const active = limiter.run(() => blocker.promise);

  const pA = limiter.run(() => { executionOrder.push('A'); return 'A'; }, { priority: 1 });
  const pB = limiter.run(() => { executionOrder.push('B'); return 'B'; }, { priority: 2, queueTimeoutMs: 10 });
  const pC = limiter.run(() => { executionOrder.push('C'); return 'C'; }, { priority: 0 });

  await assert.rejects(pB, (error) => {
    assert.equal(error.code, 'QUEUE_TIMEOUT');
    return true;
  });

  assert.equal(limiter.stats().timedOut, 1);
  assert.equal(limiter.stats().queued, 2);

  blocker.resolve();
  await active;
  await Promise.all([pA, pC]);

  assert.deepEqual(executionOrder, ['A', 'C']);
});

test('priority is respected when multiple slots free up', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 2, maxQueue: 4 });
  const blocker1 = deferred();
  const blocker2 = deferred();
  const executionOrder = [];

  const active1 = limiter.run(() => blocker1.promise);
  const active2 = limiter.run(() => blocker2.promise);

  const p3 = limiter.run(() => { executionOrder.push(3); return 3; }, { priority: 3 });
  const p1 = limiter.run(() => { executionOrder.push(1); return 1; }, { priority: 1 });
  const p2 = limiter.run(() => { executionOrder.push(2); return 2; }, { priority: 2 });
  const p0 = limiter.run(() => { executionOrder.push(0); return 0; }, { priority: 0 });

  assert.equal(limiter.stats().active, 2);
  assert.equal(limiter.stats().queued, 4);

  // Release both blockers; the limiter will start queued tasks in priority order
  // as slots become available. With maxConcurrent=2, after the first slot frees,
  // the highest priority task (3) starts, and because there is still capacity,
  // the next highest (2) also starts immediately. After the second slot frees,
  // the remaining tasks (1, 0) start.
  blocker1.resolve();
  blocker2.resolve();

  await Promise.all([active1, active2, p3, p2, p1, p0]);

  assert.deepEqual(executionOrder, [3, 2, 1, 0]);
  assert.equal(limiter.stats().active, 0);
  assert.equal(limiter.stats().queued, 0);
});

test('a non-finite priority is treated as 0 and keeps the order intact', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 3 });
  const blocker = deferred();
  const order = [];
  const active = limiter.run(() => blocker.promise);
  const a = limiter.run(() => order.push('nan'), { priority: NaN });
  const b = limiter.run(() => order.push('high'), { priority: 1 });
  const c = limiter.run(() => order.push('zero'), { priority: 0 });
  blocker.resolve();
  await active;
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['high', 'nan', 'zero']);
});
