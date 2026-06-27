import ExternalAuditLog from '../../../models/ExternalAuditLog.js';
import { logger } from '../../../utils/logger.js';
import { retryOperation } from '../../../utils/retryUtils.js';
import NodeCache from 'node-cache';
import { safeJsonStringify } from '../../../utils/jsonUtils.js';

const extLogger = logger.child({ service: 'external-gateway' });
const auditCache = new NodeCache({ stdTTL: 300 });

export function auditLogMiddleware(req, res, next) {
  const startTime = Date.now();

  // Capture request body for POST requests
  let requestBody = null;
  if (req.method === 'POST' && req.body) {
    try {
      requestBody = JSON.stringify(req.body);
    } catch (err) {
      extLogger.warn('Failed to serialize request body for audit log', { error: err.message });
    }
  }

  // Wrap res.json to capture response
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Async save with retry — don't block response
    retryOperation(() => ExternalAuditLog.create({
      timestamp: new Date(),
      method: req.method,
      path: req.originalUrl,
      agentId: req.externalAgentId || null,
      ip: req.ip,
      statusCode,
      duration,
      paymentTx: req.headers['x-payment-tx'] || null,
      success: statusCode >= 200 && statusCode < 400,
      requestBody,
      responseBody: typeof body === 'object' ? JSON.stringify(body) : String(body)
    }), { retries: 3 }).catch(err => {
      extLogger.error('Failed to save audit log after retries:', err);
    });

    extLogger.info(`${req.method} ${req.originalUrl} → ${statusCode} (${duration}ms)`, {
      agentId: req.externalAgentId,
      ip: req.ip
    });

    return originalJson(body);
  };

  next();
}

/**
 * Search audit logs with enhanced filtering capabilities
 * @param {Object} filters - Filter criteria
 * @param {number} page - Page number
 * @param {number} limit - Results per page
 * @returns {Object} Paginated audit logs
 */
export async function searchAuditLogs(filters = {}, page = 1, limit = 20) {
  const cacheKey = `audit_search_${JSON.stringify(filters)}_${page}_${limit}`;
  const cachedResult = auditCache.get(cacheKey);
  if (cachedResult) return cachedResult;

  const query = {};
  
  // Existing filters
  if (filters.method) query.method = filters.method;
  if (filters.path) query.path = { $regex: filters.path, $options: 'i' };
  if (filters.agentId) query.agentId = filters.agentId;
  
  // Enhanced date range filtering
  if (filters.startDate || filters.endDate) {
    query.timestamp = {};
    if (filters.startDate) query.timestamp.$gte = new Date(filters.startDate);
    if (filters.endDate) query.timestamp.$lte = new Date(filters.endDate);
  }
  
  // New filters for enhanced capabilities
  if (filters.minStatusCode || filters.maxStatusCode) {
    query.statusCode = {};
    if (filters.minStatusCode) query.statusCode.$gte = filters.minStatusCode;
    if (filters.maxStatusCode) query.statusCode.$lte = filters.maxStatusCode;
  }
  
  if (filters.minDuration || filters.maxDuration) {
    query.duration = {};
    if (filters.minDuration) query.duration.$gte = filters.minDuration;
    if (filters.maxDuration) query.duration.$lte = filters.maxDuration;
  }
  
  if (filters.ipPattern) {
    query.ip = { $regex: filters.ipPattern, $options: 'i' };
  }
  
  if (filters.success !== undefined) {
    query.success = filters.success;
  }

  const skip = (page - 1) * limit;
  const [logs, total] = await Promise.all([
    ExternalAuditLog.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    ExternalAuditLog.countDocuments(query)
  ]);

  const result = {
    logs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  };

  auditCache.set(cacheKey, result);
  return result;
}

/**
 * Export audit logs in specified format
 * @param {Object} filters - Filter criteria
 * @param {string} format - Export format (csv or json)
 * @returns {string} Formatted audit logs
 */
export async function exportAuditLogs(filters = {}, format = 'json') {
  const query = {};
  
  // Apply all available filters
  if (filters.method) query.method = filters.method;
  if (filters.path) query.path = { $regex: filters.path, $options: 'i' };
  if (filters.agentId) query.agentId = filters.agentId;
  
  if (filters.startDate || filters.endDate) {
    query.timestamp = {};
    if (filters.startDate) query.timestamp.$gte = new Date(filters.startDate);
    if (filters.endDate) query.timestamp.$lte = new Date(filters.endDate);
  }
  
  if (filters.minStatusCode || filters.maxStatusCode) {
    query.statusCode = {};
    if (filters.minStatusCode) query.statusCode.$gte = filters.minStatusCode;
    if (filters.maxStatusCode) query.statusCode.$lte = filters.maxStatusCode;
  }
  
  if (filters.minDuration || filters.maxDuration) {
    query.duration = {};
    if (filters.minDuration) query.duration.$gte = filters.minDuration;
    if (filters.maxDuration) query.duration.$lte = filters.maxDuration;
  }
  
  if (filters.ipPattern) {
    query.ip = { $regex: filters.ipPattern, $options: 'i' };
  }
  
  if (filters.success !== undefined) {
    query.success = filters.success;
  }

  // Fetch all matching logs (without pagination)
  const logs = await ExternalAuditLog.find(query).sort({ timestamp: -1 }).lean();
  
  if (format === 'csv') {
    // Create CSV header
    const headers = ['timestamp', 'method', 'path', 'agentId', 'ip', 'statusCode', 'duration', 'success', 'paymentTx'];
    let csvContent = headers.join(',') + '\n';
    
    // Add each log entry as a row
    for (const log of logs) {
      const row = [
        log.timestamp.toISOString(),
        log.method,
        `"${log.path}"`,
        log.agentId || '',
        log.ip,
        log.statusCode,
        log.duration,
        log.success ? 'true' : 'false',
        log.paymentTx || ''
      ].join(',');
      csvContent += row + '\n';
    }
    
    return csvContent;
  } else {
    // Default to JSON format
    return safeJsonStringify(logs, 2);
  }
}

export async function auditLogHealthCheck() {
  try {
    const dbStatus = await ExternalAuditLog.db.db.admin().ping();
    return {
      status: 'healthy',
      database: dbStatus.ok ? 'connected' : 'disconnected',
      cache: auditCache.getStats(),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}
