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
    this.cancelled = 0;
    this.timedOut = 0;
  }

  /**
   * Run an operation when a concurrency slot is available.
   *
   * Queued operations may be cancelled with an AbortSignal or rejected after
   * waiting longer than queueTimeoutMs. Neither condition allows the operation
   * to execute later.
   *
   * @param {Function} fn - Operation to execute
   * @param {Object} [options] - Queue and cancellation options
   * @param {AbortSignal} [options.signal] - Signal used to cancel queued work
   * @param {number} [options.queueTimeoutMs] - Maximum time to remain queued
   * @returns {Promise<*>} The operation result
   */
  run(fn, options = {}) {
    return new Promise((resolve, reject) => {
      const signal = options && options.signal;
      const queueTimeoutMs = options && options.queueTimeoutMs;

      if (
        queueTimeoutMs !== undefined &&
        (typeof queueTimeoutMs !== 'number' ||
          !Number.isFinite(queueTimeoutMs) ||
          queueTimeoutMs < 0)
      ) {
        const err = new TypeError('queueTimeoutMs must be a non-negative finite number');
        return reject(err);
      }

      if (signal && signal.aborted) {
        this.cancelled++;
        return reject(this._createAbortError());
      }

      if (this.active >= this.max && this.queue.length >= this.maxQueue) {
        const err = new Error('Concurrency queue full');
        err.code = 'QUEUE_FULL';
        return reject(err);
      }

      const task = {
        fn,
        resolve,
        reject,
        signal,
        queueTimeoutMs,
        state: 'queued',
        timer: null,
        abortHandler: null
      };

      if (this.active < this.max) {
        this._start(task);
      } else {
        this.queue.push(task);
        this._watchQueuedTask(task);
      }
    });
  }

  /**
   * Install cancellation and deadline handling for a queued task.
   *
   * @param {Object} task - Internal queued task
   * @returns {void}
   * @private
   */
  _watchQueuedTask(task) {
    if (task.signal && typeof task.signal.addEventListener === 'function') {
      task.abortHandler = () => {
        this._cancelQueuedTask(task);
      };
      task.signal.addEventListener('abort', task.abortHandler, { once: true });
    }

    if (task.queueTimeoutMs !== undefined) {
      task.timer = setTimeout(() => {
        this._timeoutQueuedTask(task);
      }, task.queueTimeoutMs);
    }
  }

  /**
   * Remove listeners and timers associated with a queued task.
   *
   * @param {Object} task - Internal task
   * @returns {void}
   * @private
   */
  _cleanupTask(task) {
    if (task.timer !== null) {
      clearTimeout(task.timer);
      task.timer = null;
    }

    if (
      task.abortHandler &&
      task.signal &&
      typeof task.signal.removeEventListener === 'function'
    ) {
      task.signal.removeEventListener('abort', task.abortHandler);
      task.abortHandler = null;
    }
  }

  /**
   * Remove a task from the bounded queue.
   *
   * @param {Object} task - Internal queued task
   * @returns {boolean} Whether the task was removed
   * @private
   */
  _removeQueuedTask(task) {
    const index = this.queue.indexOf(task);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    return true;
  }

  /**
   * Reject a queued task after its AbortSignal fires.
   *
   * @param {Object} task - Internal queued task
   * @returns {void}
   * @private
   */
  _cancelQueuedTask(task) {
    if (task.state !== 'queued' || !this._removeQueuedTask(task)) return;

    task.state = 'settled';
    this._cleanupTask(task);
    this.cancelled++;
    task.reject(this._createAbortError());
  }

  /**
   * Reject a queued task whose queue deadline has elapsed.
   *
   * @param {Object} task - Internal queued task
   * @returns {void}
   * @private
   */
  _timeoutQueuedTask(task) {
    if (task.state !== 'queued' || !this._removeQueuedTask(task)) return;

    task.state = 'settled';
    this._cleanupTask(task);
    this.timedOut++;

    const err = new Error('Concurrency queue timeout');
    err.code = 'QUEUE_TIMEOUT';
    task.reject(err);
  }

  /**
   * Create a standard AbortError without requiring a global DOMException.
   *
   * @returns {Error} Abort error
   * @private
   */
  _createAbortError() {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    err.code = 'ABORT_ERR';
    return err;
  }

  /**
   * Start a task and account for its active slot.
   *
   * @param {Object} task - Internal task
   * @returns {void}
   * @private
   */
  _start(task) {
    if (task.state !== 'queued') return;

    task.state = 'started';
    this._cleanupTask(task);
    this.active++;

    Promise.resolve()
      .then(task.fn)
      .then(
        (val) => {
          this._release();
          task.state = 'settled';
          task.resolve(val);
        },
        (err) => {
          this._release();
          task.state = 'settled';
          task.reject(err);
        }
      );
  }

  _release() {
    this.active--;
    if (this.queue.length > 0 && this.active < this.max) {
      const next = this.queue.shift();
      this._start(next);
    }
  }

  stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      max: this.max,
      maxQueue: this.maxQueue,
      cancelled: this.cancelled,
      timedOut: this.timedOut
    };
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
      this._start(next);
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
