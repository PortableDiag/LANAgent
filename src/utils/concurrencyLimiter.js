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
    this.initialMax = this.max;
    this.initialMaxQueue = this.maxQueue;
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

  /**
   * Update the concurrency limiter configuration at runtime
   * @param {Object} config - Configuration object
   * @param {number} [config.maxConcurrent] - Maximum concurrent operations
   * @param {number} [config.maxQueue] - Maximum queue size
   * @returns {Object} Updated configuration
   */
  updateConfig(config) {
    if (typeof config !== 'object' || config === null) {
      throw new Error('Configuration must be an object');
    }

    if (config.maxConcurrent !== undefined) {
      if (typeof config.maxConcurrent !== 'number' || config.maxConcurrent < 1) {
        throw new Error('maxConcurrent must be a number greater than 0');
      }
      this.max = Math.floor(config.maxConcurrent);
    }

    if (config.maxQueue !== undefined) {
      if (typeof config.maxQueue !== 'number' || config.maxQueue < 0) {
        throw new Error('maxQueue must be a non-negative number');
      }
      this.maxQueue = Math.floor(config.maxQueue);
    }

    // Process queued tasks if capacity has increased
    while (this.queue.length > 0 && this.active < this.max) {
      const next = this.queue.shift();
      next();
    }

    return this.getConfig();
  }

  /**
   * Get current configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return {
      maxConcurrent: this.max,
      maxQueue: this.maxQueue
    };
  }

  /**
   * Reset configuration to initial values
   * @returns {Object} Reset configuration
   */
  reset() {
    return this.updateConfig({
      maxConcurrent: this.initialMax,
      maxQueue: this.initialMaxQueue
    });
  }
}

export default ConcurrencyLimiter;
