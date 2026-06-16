import { logger } from './logger.js';
import { safeJsonStringify } from './jsonUtils.js';

/**
 * Resource Manager for tracking and cleaning up timers, intervals, and connections
 */
class ResourceManager {
  constructor() {
    this.resources = {
      intervals: new Map(),
      timeouts: new Map(),
      connections: new Map(),
      servers: new Map(),
      streams: new Map()
    };
    
    // Track resource creation for debugging
    this.resourceStats = {
      created: 0,
      cleaned: 0,
      active: 0
    };

    // Thresholds for resource usage alerts
    this.thresholds = {
      intervals: 100,
      timeouts: 100,
      connections: 50,
      servers: 10,
      streams: 50
    };

    // Initialize resource usage analytics
    this.resourceUsageHistory = [];
  }

  /**
   * Check if resource usage exceeds thresholds and trigger alerts
   */
  checkThreshold(type) {
    const currentUsage = this.resources[type]?.size || 0;
    const threshold = this.thresholds[type];
    if (threshold && currentUsage > threshold) {
      logger.warn(`Resource threshold exceeded: ${type} usage is ${currentUsage}, exceeds threshold of ${threshold}`);
    }
  }
  
  /**
   * Register an interval with cleanup tracking
   */
  registerInterval(id, interval, description = '') {
    this.resources.intervals.set(id, {
      interval,
      description,
      createdAt: new Date()
    });
    this.resourceStats.created++;
    this.resourceStats.active++;
    this.checkThreshold('intervals');
    logger.debug(`Registered interval: ${id} - ${description}`);
    return interval;
  }
  
  /**
   * Register a timeout with cleanup tracking
   */
  registerTimeout(id, timeout, description = '') {
    this.resources.timeouts.set(id, {
      timeout,
      description,
      createdAt: new Date()
    });
    this.resourceStats.created++;
    this.resourceStats.active++;
    this.checkThreshold('timeouts');
    logger.debug(`Registered timeout: ${id} - ${description}`);
    return timeout;
  }
  
  /**
   * Register a connection (socket, database, etc.)
   */
  registerConnection(id, connection, description = '') {
    this.resources.connections.set(id, {
      connection,
      description,
      createdAt: new Date()
    });
    this.resourceStats.created++;
    this.resourceStats.active++;
    this.checkThreshold('connections');
    logger.debug(`Registered connection: ${id} - ${description}`);
    return connection;
  }
  
  /**
   * Register a server instance
   */
  registerServer(id, server, description = '') {
    this.resources.servers.set(id, {
      server,
      description,
      createdAt: new Date()
    });
    this.resourceStats.created++;
    this.resourceStats.active++;
    this.checkThreshold('servers');
    logger.debug(`Registered server: ${id} - ${description}`);
    return server;
  }
  
  /**
   * Clean up a specific interval
   */
  cleanupInterval(id) {
    const resource = this.resources.intervals.get(id);
    if (resource) {
      clearInterval(resource.interval);
      this.resources.intervals.delete(id);
      this.resourceStats.cleaned++;
      this.resourceStats.active--;
      logger.debug(`Cleaned up interval: ${id}`);
      return true;
    }
    return false;
  }
  
  /**
   * Clean up a specific timeout
   */
  cleanupTimeout(id) {
    const resource = this.resources.timeouts.get(id);
    if (resource) {
      clearTimeout(resource.timeout);
      this.resources.timeouts.delete(id);
      this.resourceStats.cleaned++;
      this.resourceStats.active--;
      logger.debug(`Cleaned up timeout: ${id}`);
      return true;
    }
    return false;
  }
  
  /**
   * Clean up a specific connection
   */
  async cleanupConnection(id) {
    const resource = this.resources.connections.get(id);
    if (resource) {
      try {
        const conn = resource.connection;
        
        // Handle different connection types
        if (typeof conn.close === 'function') {
          await conn.close();
        } else if (typeof conn.end === 'function') {
          await conn.end();
        } else if (typeof conn.destroy === 'function') {
          conn.destroy();
        } else if (typeof conn.disconnect === 'function') {
          await conn.disconnect();
        }
        
        this.resources.connections.delete(id);
        this.resourceStats.cleaned++;
        this.resourceStats.active--;
        logger.debug(`Cleaned up connection: ${id}`);
        return true;
      } catch (error) {
        logger.error(`Error cleaning up connection ${id}:`, error);
        return false;
      }
    }
    return false;
  }
  
  /**
   * Clean up a server instance
   */
  async cleanupServer(id) {
    const resource = this.resources.servers.get(id);
    if (resource) {
      try {
        const server = resource.server;
        
        await new Promise((resolve, reject) => {
          server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        
        this.resources.servers.delete(id);
        this.resourceStats.cleaned++;
        this.resourceStats.active--;
        logger.debug(`Cleaned up server: ${id}`);
        return true;
      } catch (error) {
        logger.error(`Error cleaning up server ${id}:`, error);
        return false;
      }
    }
    return false;
  }
  
  /**
   * Clean up all resources of a specific type
   */
  async cleanupByType(type) {
    const cleanupMethods = {
      intervals: this.cleanupInterval.bind(this),
      timeouts: this.cleanupTimeout.bind(this),
      connections: this.cleanupConnection.bind(this),
      servers: this.cleanupServer.bind(this)
    };
    
    const method = cleanupMethods[type];
    if (!method) {
      logger.warn(`Unknown resource type: ${type}`);
      return 0;
    }
    
    const resources = this.resources[type];
    let cleaned = 0;
    
    for (const [id] of resources) {
      if (await method(id)) {
        cleaned++;
      }
    }
    
    logger.info(`Cleaned up ${cleaned} ${type}`);
    return cleaned;
  }
  
  /**
   * Clean up all resources
   */
  async cleanupAll() {
    logger.info('Cleaning up all resources...');
    
    const results = {
      intervals: await this.cleanupByType('intervals'),
      timeouts: await this.cleanupByType('timeouts'),
      connections: await this.cleanupByType('connections'),
      servers: await this.cleanupByType('servers')
    };
    
    logger.info('Resource cleanup complete:', results);
    return results;
  }
  
  /**
   * Get resource statistics
   */
  getStats() {
    return {
      ...this.resourceStats,
      byType: {
        intervals: this.resources.intervals.size,
        timeouts: this.resources.timeouts.size,
        connections: this.resources.connections.size,
        servers: this.resources.servers.size
      }
    };
  }
  
  /**
   * List all active resources
   */
  listResources() {
    const list = {};
    
    for (const [type, resources] of Object.entries(this.resources)) {
      list[type] = [];
      for (const [id, resource] of resources) {
        list[type].push({
          id,
          description: resource.description,
          createdAt: resource.createdAt,
          age: Date.now() - resource.createdAt.getTime()
        });
      }
    }
    
    return list;
  }

  /**
   * Analyze resource usage patterns and generate a report
   */
  analyzeResourceUsage() {
    const snapshot = {
      timestamp: new Date(),
      stats: this.getStats()
    };
    this.resourceUsageHistory.push(snapshot);
    logger.info('Resource usage snapshot taken:', safeJsonStringify(snapshot));
  }

  /**
   * Generate a report of resource usage over time
   */
  generateResourceUsageReport() {
    const report = this.resourceUsageHistory.map(entry => ({
      timestamp: entry.timestamp,
      stats: entry.stats
    }));
    logger.info('Generated resource usage report:', safeJsonStringify(report));
    return report;
  }

  /**
   * Predict future resource usage based on historical data
   */
  predictResourceUsage() {
    if (this.resourceUsageHistory.length < 2) {
      logger.warn('Insufficient data for prediction');
      return null;
    }

    const predictions = {};
    const latestStats = this.resourceUsageHistory[this.resourceUsageHistory.length - 1].stats.byType;

    for (const type in latestStats) {
      const usageHistory = this.resourceUsageHistory.map(entry => entry.stats.byType[type]);
      const averageGrowth = this.calculateAverageGrowth(usageHistory);
      predictions[type] = Math.max(0, Math.round(latestStats[type] * (1 + averageGrowth)));
    }

    logger.info('Predicted future resource usage:', safeJsonStringify(predictions));
    return predictions;
  }

  /**
   * Calculate average growth rate from historical data
   */
  calculateAverageGrowth(usageHistory) {
    let totalGrowth = 0;
    let count = 0;

    for (let i = 1; i < usageHistory.length; i++) {
      if (usageHistory[i - 1] === 0) continue; // Skip zero-base entries to avoid division by zero
      const growth = (usageHistory[i] - usageHistory[i - 1]) / usageHistory[i - 1];
      totalGrowth += growth;
      count++;
    }

    return count > 0 ? totalGrowth / count : 0;
  }
}

// Singleton instance
export const resourceManager = new ResourceManager();

// Convenience methods for safe resource creation
export function createManagedInterval(callback, delay, id, description = '') {
  const interval = setInterval(callback, delay);
  return resourceManager.registerInterval(id, interval, description);
}

export function createManagedTimeout(callback, delay, id, description = '') {
  const timeout = setTimeout(callback, delay);
  return resourceManager.registerTimeout(id, timeout, description);
}