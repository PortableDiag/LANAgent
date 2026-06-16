/**
 * ConcurrencyLimiter — a tiny in-process semaphore with a bounded queue.
 * No external dependency. Used to cap simultaneous heavy operations (e.g. large
 * AVIF transcodes) so a burst can't OOM the box or starve other work (trading).
 *
 *   const limiter = new ConcurrencyLimiter({ maxConcurrent: 2, maxQueue: 8 });
 *   await limiter.run(() => doHeavyThing());   // queues if all slots busy
 *
 * If both the active slots AND the queue are full, run() rejects immediately with
 * an Error whose `.code === 'QUEUE_FULL'` so the caller can shed load (503) rather
 * than buffer unbounded work in memory.
 */
export class ConcurrencyLimiter {
  constructor({ maxConcurrent = 2, maxQueue = 8 } = {}) {
    this.max = Math.max(1, maxConcurrent);
    this.maxQueue = Math.max(0, maxQueue);
    this.active = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      if (this.active >= this.max && this.queue.length >= this.maxQueue) {
        const err = new Error('Concurrency queue full');
        err.code = 'QUEUE_FULL';
        return reject(err);
      }
      const task = () => {
        this.active++;
        Promise.resolve()
          .then(fn)
          .then(
            (val) => { this._release(); resolve(val); },
            (err) => { this._release(); reject(err); }
          );
      };
      if (this.active < this.max) task();
      else this.queue.push(task);
    });
  }

  _release() {
    this.active--;
    if (this.queue.length > 0 && this.active < this.max) {
      const next = this.queue.shift();
      next();
    }
  }

  stats() {
    return { active: this.active, queued: this.queue.length, max: this.max, maxQueue: this.maxQueue };
  }
}

export default ConcurrencyLimiter;
