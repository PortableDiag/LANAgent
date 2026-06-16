import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import NodeCache from 'node-cache';
import { EventEmitter } from 'events';
import { retryOperation } from '../utils/retryUtils.js';
import { safeTimeout, safeInterval } from '../utils/errorHandlers.js';

/**
 * Shared lock manager for self-modification processes
 * Ensures only one process (self-mod, plugin dev, or bug fixing) runs at a time
 */
export class SelfModLock extends EventEmitter {
  constructor() {
    super();
    this.lockFile = path.join(process.cwd(), '.selfmod.lock');
    this.lockTimeout = 30 * 60 * 1000; // 30 minutes timeout
    this.notificationLeadTime = 5 * 60 * 1000; // 5 minutes before timeout
    // Tracked timer handle so release() can cancel a pending expiration
    // notification — otherwise the warning fires for a lock that was
    // properly released minutes earlier.
    this._expirationTimer = null;
    // Use node-cache for in-memory caching with 5 minute TTL
    this.cache = new NodeCache({ stdTTL: 300 });
    // KeepAlive (lease renewal) state
    this._keepAliveTimer = null;
    this._keepAliveStartedAt = null;
    this._keepAliveService = null;
  }
  
  /**
   * Try to acquire the lock
   * @param {string} service - Name of the service trying to acquire lock
   * @returns {Promise<boolean>} - True if lock acquired, false if already locked
   */
  async acquire(service, options = {}) {
    try {
      // Check if lock exists and is still valid (with caching)
      const lockData = await this.getCachedLock();
      
      if (lockData) {
        // Check if lock has timed out
        const lockAge = Date.now() - new Date(lockData.timestamp).getTime();
        
        // Check if the process holding the lock is still alive
        const processAlive = lockData.pid ? this.isProcessAlive(lockData.pid) : false;
        
        if (lockAge < this.lockTimeout && processAlive) {
          logger.warn(`Lock is held by ${lockData.service} since ${lockData.timestamp}. Cannot acquire for ${service}.`);
          return false;
        }
        
        if (!processAlive) {
          logger.info(`Previous lock by ${lockData.service} held by dead process ${lockData.pid}. Clearing lock for ${service}.`);
        } else {
          logger.info(`Previous lock by ${lockData.service} has timed out. Acquiring new lock for ${service}.`);
        }
      }
      
      // Create or update lock
      const newLock = {
        service,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        lastUpdated: new Date().toISOString()
      };
      
      await retryOperation(() => fs.writeFile(this.lockFile, JSON.stringify(newLock, null, 2)), { retries: 3 });
      this.cache.set('lock', newLock);
      logger.info(`Lock acquired by ${service}`);
      this.emit('lockAcquired', service);

      // Schedule notification for lock expiration
      this.scheduleLockExpirationNotification(service);

      if (options.keepAlive) {
        const cfg = typeof options.keepAlive === 'object' ? options.keepAlive : {};
        this.startKeepAlive(service, cfg);
      }

      return true;

    } catch (error) {
      if (error.code === 'ENOENT') {
        // No lock file exists, create it
        const newLock = {
          service,
          timestamp: new Date().toISOString(),
          pid: process.pid
        };
        
        await retryOperation(() => fs.writeFile(this.lockFile, JSON.stringify(newLock, null, 2)), { retries: 3 });
        this.cache.set('lock', newLock);
        logger.info(`Lock created and acquired by ${service}`);
        this.emit('lockAcquired', service);

        // Schedule notification for lock expiration
        this.scheduleLockExpirationNotification(service);

        if (options.keepAlive) {
          const cfg = typeof options.keepAlive === 'object' ? options.keepAlive : {};
          this.startKeepAlive(service, cfg);
        }

        return true;
      }

      logger.error(`Failed to acquire lock for ${service}:`, error);
      return false;
    }
  }
  
  /**
   * Release the lock
   * @param {string} service - Name of the service releasing lock
   */
  async release(service) {
    try {
      const lockData = await this.getCachedLock();
      
      if (lockData && lockData.service === service) {
        await retryOperation(() => fs.unlink(this.lockFile), { retries: 3 });
        this.cache.del('lock');
        if (this._expirationTimer) {
          clearTimeout(this._expirationTimer);
          this._expirationTimer = null;
        }
        this.stopKeepAlive();
        logger.info(`Lock released by ${service}`);
        this.emit('lockReleased', service);
      } else {
        logger.warn(`${service} tried to release lock but it was held by ${lockData?.service || 'unknown'}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`Failed to release lock for ${service}:`, error);
      }
    }
  }
  
  /**
   * Check if lock is currently held
   * @returns {Promise<{service: string, timestamp: string} | null>}
   */
  async check() {
    const lockData = await this.getCachedLock();
    
    if (lockData) {
      const lockAge = Date.now() - new Date(lockData.timestamp).getTime();
      if (lockAge < this.lockTimeout) {
        return lockData;
      }
    }
    
    return null;
  }
  
  /**
   * Get lock data with caching
   * @private
   * @returns {Promise<{service: string, timestamp: string} | null>}
   */
  async getCachedLock() {
    const cached = this.cache.get('lock');
    if (cached) {
      return cached;
    }
    
    const lockData = await this.readLock();
    if (lockData) {
      this.cache.set('lock', lockData);
    }
    return lockData;
  }
  
  /**
   * Read lock file
   * @private
   */
  async readLock() {
    try {
      const content = await fs.readFile(this.lockFile, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
  
  /**
   * Force clear the lock (for emergency use)
   */
  async forceClear() {
    try {
      await retryOperation(() => fs.unlink(this.lockFile), { retries: 3 });
      this.cache.del('lock');
      logger.warn('Lock forcefully cleared');
      this.emit('lockForceCleared');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to force clear lock:', error);
      }
    }
  }
  
  /**
   * Check if lock is currently held (synchronous check for compatibility)
   * @returns {boolean}
   */
  isLocked() {
    try {
      const lockData = this.readLockSync();
      if (lockData) {
        const lockAge = Date.now() - new Date(lockData.timestamp).getTime();
        return lockAge < this.lockTimeout;
      }
      return false;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Get lock info (synchronous for compatibility)
   * @returns {{service: string, timestamp: string, branch?: string} | null}
   */
  getLockInfo() {
    try {
      const lockData = this.readLockSync();
      if (lockData) {
        const lockAge = Date.now() - new Date(lockData.timestamp).getTime();
        if (lockAge < this.lockTimeout) {
          return lockData;
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Read lock file synchronously
   * @private
   */
  readLockSync() {
    try {
      const fs = require('fs');
      const content = fs.readFileSync(this.lockFile, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
  
  /**
   * Check if a process is still alive
   * @private
   */
  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  }
  
  /**
   * Update lock with additional info (like git branch)
   * @param {string} service - Service holding the lock
   * @param {Object} additionalInfo - Additional information to store
   */
  async updateLockInfo(service, additionalInfo) {
    try {
      const lockData = await this.getCachedLock();
      if (lockData && lockData.service === service) {
        const updatedLock = {
          ...lockData,
          ...additionalInfo,
          lastUpdated: new Date().toISOString()
        };
        await retryOperation(() => fs.writeFile(this.lockFile, JSON.stringify(updatedLock, null, 2)), { retries: 3 });
        this.cache.set('lock', updatedLock);
        logger.info(`Lock info updated by ${service}`);
      }
    } catch (error) {
      logger.error(`Failed to update lock info for ${service}:`, error);
    }
  }

  /**
   * Schedule a notification for when the lock is about to expire
   * @param {string} service - Service holding the lock
   * @private
   */
  scheduleLockExpirationNotification(service) {
    const lockData = this.cache.get('lock');
    if (!lockData) return;

    const lockAge = Date.now() - new Date(lockData.timestamp).getTime();
    const timeUntilNotification = this.lockTimeout - lockAge - this.notificationLeadTime;
    if (timeUntilNotification <= 0) return;

    // Cancel any prior pending notification (acquire-after-release reuse)
    if (this._expirationTimer) clearTimeout(this._expirationTimer);

    this._expirationTimer = safeTimeout(() => {
      this._expirationTimer = null;
      // Guard — the lock might have been released or re-acquired by a
      // different service since we scheduled this. Only warn if the
      // original holder is still in possession.
      const current = this.cache.get('lock');
      if (current?.service !== service) return;
      this.emit('lockExpiring', service);
      logger.info(`Lock for ${service} is about to expire.`);
    }, timeUntilNotification, 'selfModLock-expirationNotice');
  }

  /**
   * Renew the current lock if held by the same service. Refreshes the
   * timestamp (effectively extending the lease) and re-arms the expiration
   * notification. Returns false if no lock exists, a different service holds
   * it, or the recorded process is no longer alive.
   * @param {string} service
   * @param {Object} [opts]
   * @param {number} [opts.extendMs] - extend timestamp this many ms past now
   */
  async renew(service, { extendMs } = {}) {
    try {
      const lockData = await this.getCachedLock();
      if (!lockData) return false;
      if (lockData.service !== service) {
        logger.warn(`Renew denied: ${service} does not hold the lock (held by ${lockData.service}).`);
        return false;
      }
      if (lockData.pid && !this.isProcessAlive(lockData.pid)) {
        logger.warn(`Renew denied for ${service}: recorded pid ${lockData.pid} is not alive.`);
        return false;
      }

      const now = Date.now();
      const newTimestampMs = (typeof extendMs === 'number' && extendMs > 0)
        ? Math.max(new Date(lockData.timestamp).getTime(), now) + extendMs
        : now;

      const updated = {
        ...lockData,
        timestamp: new Date(newTimestampMs).toISOString(),
        lastUpdated: new Date().toISOString()
      };
      await retryOperation(() => fs.writeFile(this.lockFile, JSON.stringify(updated, null, 2)), { retries: 3 });
      this.cache.set('lock', updated);
      this.scheduleLockExpirationNotification(service);
      this.emit('lockRenewed', service, { extendMs });
      return true;
    } catch (err) {
      logger.error(`Failed to renew lock for ${service}:`, err);
      return false;
    }
  }

  /**
   * Start automatic keep-alive renewals. Pairs with acquire({keepAlive:true})
   * for long-running tasks that exceed the 30-minute lock timeout.
   */
  startKeepAlive(service, { intervalMs = 60_000, maxDurationMs } = {}) {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    this._keepAliveStartedAt = Date.now();
    this._keepAliveService = service;

    const tick = async () => {
      if (typeof maxDurationMs === 'number' && maxDurationMs > 0 &&
          Date.now() - this._keepAliveStartedAt >= maxDurationMs) {
        logger.info(`KeepAlive maxDurationMs reached for ${service}, stopping.`);
        this.stopKeepAlive();
        return;
      }
      const ok = await this.renew(service);
      if (!ok) {
        logger.warn(`KeepAlive renew failed for ${service}, stopping to avoid false ownership.`);
        this.stopKeepAlive();
      }
    };

    this._keepAliveTimer = safeInterval(tick, intervalMs, 'selfModLock-keepAlive');
    logger.info(`KeepAlive started for ${service} (intervalMs=${intervalMs}${maxDurationMs ? `, maxDurationMs=${maxDurationMs}` : ''}).`);
  }

  stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
      this._keepAliveStartedAt = null;
      this._keepAliveService = null;
      logger.info('KeepAlive stopped.');
    }
  }
}

// Singleton instance
export const selfModLock = new SelfModLock();
