import { logger } from '../utils/logger.js';
import { safeJsonStringify } from '../utils/jsonUtils.js';

/**
 * OperationLogger - Tracks all agent operations for auditing
 */
export class OperationLogger {
  constructor() {
    this.operations = [];
    this.maxOperations = 1000;
  }

  /**
   * Log an operation
   * @param {Object} operation - Operation details
   * @param {string} operation.type - Type of operation (plugin, command, email, etc.)
   * @param {string} operation.action - Specific action taken
   * @param {string} operation.plugin - Plugin name if applicable
   * @param {Object} operation.params - Parameters used
   * @param {Object} operation.result - Result of the operation
   * @param {string} operation.status - success, error, pending
   * @param {string} operation.userId - User who triggered the operation
   * @param {string} operation.interface - Interface used (telegram, web, ssh)
   */
  logOperation(operation) {
    const entry = {
      id: this.generateId(),
      timestamp: new Date(),
      type: operation.type || 'unknown',
      action: operation.action || 'unknown',
      plugin: operation.plugin || null,
      params: this.sanitizeParams(operation.params),
      result: this.sanitizeResult(operation.result),
      status: operation.status || 'unknown',
      userId: operation.userId || 'system',
      interface: operation.interface || 'unknown',
      duration: operation.duration || null
    };

    this.operations.push(entry);
    
    // Keep size limited
    if (this.operations.length > this.maxOperations) {
      this.operations.shift();
    }

    // Also log to standard logger for persistent storage
    logger.info('Operation executed:', {
      type: entry.type,
      action: entry.action,
      plugin: entry.plugin,
      status: entry.status,
      userId: entry.userId
    });

    return entry;
  }

  /**
   * Get operation history
   * @param {number} limit - Number of operations to return
   * @param {Object} filters - Optional filters
   */
  getHistory(limit = 50, filters = {}) {
    let ops = [...this.operations];

    // Apply filters
    if (filters.type) {
      ops = ops.filter(op => op.type === filters.type);
    }
    if (filters.plugin) {
      ops = ops.filter(op => op.plugin === filters.plugin);
    }
    if (filters.status) {
      ops = ops.filter(op => op.status === filters.status);
    }
    if (filters.userId) {
      ops = ops.filter(op => op.userId === filters.userId);
    }
    if (filters.startTime) {
      ops = ops.filter(op => op.timestamp >= filters.startTime);
    }

    // Sort by timestamp desc and limit
    return ops
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get operations summary
   */
  getSummary() {
    const summary = {
      total: this.operations.length,
      byType: {},
      byPlugin: {},
      byStatus: {},
      byInterface: {},
      last24Hours: 0,
      lastHour: 0
    };

    const now = new Date();
    const hourAgo = new Date(now - 60 * 60 * 1000);
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

    this.operations.forEach(op => {
      // Count by type
      summary.byType[op.type] = (summary.byType[op.type] || 0) + 1;
      
      // Count by plugin
      if (op.plugin) {
        summary.byPlugin[op.plugin] = (summary.byPlugin[op.plugin] || 0) + 1;
      }
      
      // Count by status
      summary.byStatus[op.status] = (summary.byStatus[op.status] || 0) + 1;
      
      // Count by interface
      summary.byInterface[op.interface] = (summary.byInterface[op.interface] || 0) + 1;
      
      // Time-based counts
      if (op.timestamp >= dayAgo) {
        summary.last24Hours++;
      }
      if (op.timestamp >= hourAgo) {
        summary.lastHour++;
      }
    });

    return summary;
  }

  /**
   * Clear operation history
   */
  clearHistory() {
    this.operations = [];
    logger.info('Operation history cleared');
  }

  /**
   * Format operations for display
   */
  formatForDisplay(operations) {
    return operations.map(op => ({
      time: this.formatTime(op.timestamp),
      type: op.type,
      action: op.action,
      plugin: op.plugin || '-',
      status: this.formatStatus(op.status),
      user: op.userId,
      interface: op.interface,
      details: this.formatDetails(op)
    }));
  }

  /**
   * Format for Telegram display
   */
  formatForTelegram(limit = 10) {
    const ops = this.getHistory(limit);
    if (ops.length === 0) {
      return '📋 No recent operations';
    }

    let message = '📋 Recent Operations:\n\n';
    ops.forEach((op, index) => {
      const icon = this.getOperationIcon(op.type);
      const time = this.formatTimeShort(op.timestamp);
      message += `${icon} ${time} - ${op.action}\n`;
      if (op.plugin) {
        message += `   Plugin: ${op.plugin}\n`;
      }
      message += `   Status: ${this.formatStatus(op.status)}\n`;
      if (op.result && op.result.error) {
        message += `   Error: ${op.result.error}\n`;
      }
      message += '\n';
    });

    return message;
  }

  // Helper methods
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  sanitizeParams(params) {
    if (!params) return {};
    
    // Remove sensitive data
    const sanitized = { ...params };
    const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth'];
    
    Object.keys(sanitized).forEach(key => {
      if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
        sanitized[key] = '***';
      }
    });
    
    return sanitized;
  }

  sanitizeResult(result) {
    if (!result) return null;
    
    // Limit result size and remove sensitive data
    if (typeof result === 'string' && result.length > 200) {
      return result.substring(0, 200) + '...';
    }
    
    if (typeof result === 'object') {
      const sanitized = { ...result };
      if (sanitized.stdout && sanitized.stdout.length > 200) {
        sanitized.stdout = sanitized.stdout.substring(0, 200) + '...';
      }
      if (sanitized.stderr && sanitized.stderr.length > 200) {
        sanitized.stderr = sanitized.stderr.substring(0, 200) + '...';
      }
      return sanitized;
    }
    
    return result;
  }

  formatTime(date) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(date);
  }

  formatTimeShort(date) {
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  formatStatus(status) {
    const statusMap = {
      success: '✅ Success',
      error: '❌ Error',
      pending: '⏳ Pending',
      warning: '⚠️ Warning'
    };
    return statusMap[status] || status;
  }

  formatDetails(op) {
    const details = [];
    
    if (op.params && Object.keys(op.params).length > 0) {
      details.push(`Params: ${safeJsonStringify(op.params)}`);
    }
    
    if (op.result) {
      if (typeof op.result === 'string') {
        details.push(`Result: ${op.result}`);
      } else if (op.result.message) {
        details.push(`Result: ${op.result.message}`);
      }
    }
    
    if (op.duration) {
      details.push(`Duration: ${op.duration}ms`);
    }
    
    return details.join(' | ');
  }

  getOperationIcon(type) {
    const iconMap = {
      plugin: '🔌',
      command: '💻',
      email: '📧',
      task: '📋',
      git: '🔀',
      search: '🔍',
      system: '⚙️',
      file: '📄',
      api: '🌐',
      ai: '🤖'
    };
    return iconMap[type] || '📌';
  }
}

export default OperationLogger;