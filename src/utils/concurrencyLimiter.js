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
 *
 * Since v2 the wait queue is organised as a max-heap ordered by task priority
 * (higher number = higher priority) with insertion-order tie‑breaking, allowing
 * critical work to jump ahead of lower‑priority work during bursts.
 */
export class ConcurrencyLimiter {
  constructor({ maxConcurrent = 2, maxQueue = 8 } = {}) {
    this.max = Math.max(1, maxConcurrent);
    this.maxQueue = Math.max(0, maxQueue);
    this.active = 0;
    this.queue = [];            // binary max-heap (priority desc, order asc)
    this._nextOrder = 0;        // monotonically increasing insertion sequence
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
   * @param {number} [options.priority] - Task priority (higher = more urgent, default 0)
   * @returns {Promise<*>} The operation result
   */
  run(fn, options = {}) {
    return new Promise((resolve, reject) => {
      const signal = options && options.signal;
      const queueTimeoutMs = options && options.queueTimeoutMs;
      // NaN would make every comparison false and corrupt the heap order
      const priority = (options && Number.isFinite(options.priority))
        ? options.priority
        : 0;

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
        priority,
        order: this._nextOrder++,
        state: 'queued',
        timer: null,
        abortHandler: null
      };

      if (this.active < this.max) {
        this._start(task);
      } else {
        this._heapEnqueue(task);
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
   * Remove a task from the bounded priority heap.
   *
   * @param {Object} task - Internal queued task
   * @returns {boolean} Whether the task was removed
   * @private
   */
  _removeQueuedTask(task) {
    return this._heapRemoveTask(task);
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
      const next = this._heapDequeue();
      if (next) this._start(next);
    }
  }

  // --------------------------------------------------------------------------
  //  Priority heap (max-heap by priority desc, then order asc)
  // --------------------------------------------------------------------------

  /**
   * Insert a task into the priority heap.
   * @param {Object} task
   * @private
   */
  _heapEnqueue(task) {
    this.queue.push(task);
    this._siftUp(this.queue.length - 1);
  }

  /**
   * Extract the highest-priority task from the heap.
   * @returns {Object|null} The task, or null if heap empty
   * @private
   */
  _heapDequeue() {
    if (this.queue.length === 0) return null;

    const root = this.queue[0];
    const last = this.queue.pop();
    if (this.queue.length > 0) {
      this.queue[0] = last;
      this._siftDown(0);
    }
    return root;
  }

  /**
   * Remove a specific task from the heap (used for cancellation / timeout).
   * @param {Object} task
   * @returns {boolean} true if found and removed
   * @private
   */
  _heapRemoveTask(task) {
    const idx = this._heapIndexOf(task);
    if (idx === -1) return false;

    // Replace with last element, then restore heap property
    const last = this.queue.pop();
    if (idx < this.queue.length) {
      this.queue[idx] = last;
      // After replacement we may need to move up or down; sift both.
      this._siftUp(idx);
      this._siftDown(idx);
    }
    return true;
  }

  /**
   * Linear scan to find task index – acceptable because maxQueue is small.
   * @param {Object} task
   * @returns {number}
   * @private
   */
  _heapIndexOf(task) {
    // tasks are objects; strict reference equality works
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i] === task) return i;
    }
    return -1;
  }

  /**
   * Compare two tasks: higher priority first; if equal, earlier insertion wins.
   * @param {Object} a
   * @param {Object} b
   * @returns {boolean} true if a is "higher priority" than b
   * @private
   */
  _isHigherPriority(a, b) {
    if (a.priority !== b.priority) return a.priority > b.priority;
    return a.order < b.order;
  }

  /**
   * Sift a node up to maintain the max-heap property.
   * @param {number} idx
   * @private
   */
  _siftUp(idx) {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      if (this._isHigherPriority(this.queue[idx], this.queue[parent])) {
        [this.queue[idx], this.queue[parent]] = [this.queue[parent], this.queue[idx]];
        idx = parent;
      } else {
        break;
      }
    }
  }

  /**
   * Sift a node down to maintain the max-heap property.
   * @param {number} idx
   * @private
   */
  _siftDown(idx) {
    const length = this.queue.length;
    while (true) {
      let largest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;

      if (left < length && this._isHigherPriority(this.queue[left], this.queue[largest])) {
        largest = left;
      }
      if (right < length && this._isHigherPriority(this.queue[right], this.queue[largest])) {
        largest = right;
      }

      if (largest === idx) break;

      [this.queue[idx], this.queue[largest]] = [this.queue[largest], this.queue[idx]];
      idx = largest;
    }
  }

  // --------------------------------------------------------------------------
  //  Stats & configuration (unchanged public API)
  // --------------------------------------------------------------------------

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
      const next = this._heapDequeue();
      if (next) this._start(next);
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
